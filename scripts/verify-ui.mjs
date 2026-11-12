// 通过 CDP 驱动 Edge 打开 Harness 页面，检查「实时画面」面板是否真的注册渲染。
// 用法：node scripts/verify-ui.mjs <url> [port]
// 依赖：本机 Edge + node 的全局 WebSocket（node >= 22）。
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const url = process.argv[2]
if (!url) {
  console.error('用法: node scripts/verify-ui.mjs <url> [port]')
  process.exit(2)
}
const port = Number(process.argv[3] ?? 9333)
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const profile = path.join(process.env.TEMP ?? '.', `dsh-ls-cdp-${Date.now()}`)
const shotDir = path.resolve('out')
mkdirSync(shotDir, { recursive: true })

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`[ui] ${ok ? 'PASS' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`)
}

const child = spawn(EDGE, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,MediaRouter',
  '--window-size=1440,960',
  '--headless=new',
  'about:blank'
], { stdio: 'ignore', windowsHide: true })

/** 等到 CDP 的 /json/version 可用。 */
async function waitForCdp (timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
    } catch {}
    await sleep(300)
  }
  throw new Error('CDP 没起来')
}

/** 极简 CDP 客户端：一次只有一个 inflight 命令，按 id 匹配回包。 */
class Cdp {
  constructor (ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.events = []
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      } else if (msg.method) {
        this.events.push(msg)
      }
    })
  }

  send (method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

async function openTarget () {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  const target = await res.json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  return { cdp: new Cdp(ws), ws, target }
}

const evaluate = async (cdp, expression) => {
  const out = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  return out.result?.value
}

try {
  await waitForCdp()
  const { cdp, ws } = await openTarget()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Page.navigate', { url })

  // 等页面真正渲染出侧边栏（最多 30s）。
  let ready = false
  for (let i = 0; i < 60; i += 1) {
    await sleep(500)
    const has = await evaluate(cdp, 'document.querySelectorAll("button,[role=button]").length')
    if (typeof has === 'number' && has > 3) { ready = true; break }
  }
  check('页面渲染出交互元素', ready)

  const title = await evaluate(cdp, 'document.title')
  console.log('[ui] title =', title)

  // 1) 侧边栏面板图标是否出现（label 来自 locale，中文「实时画面」）。
  const panelInfo = await evaluate(cdp, `(() => {
    const all = [...document.querySelectorAll('[aria-label],[title]')]
    const hit = all.filter((el) => {
      const label = (el.getAttribute('aria-label') || '') + '|' + (el.getAttribute('title') || '')
      return label.includes('实时画面') || label.includes('Live Screen') || label.includes('live-screen')
    })
    return { count: hit.length, sample: hit.slice(0, 3).map((el) => (el.getAttribute('aria-label') || el.getAttribute('title'))) }
  })()`)
  console.log('[ui] panel icons =', JSON.stringify(panelInfo))
  check('侧边栏出现「实时画面」入口', (panelInfo?.count ?? 0) > 0)

  // 2) 点它，看主区是否切到面板。
  const clicked = await evaluate(cdp, `(() => {
    const all = [...document.querySelectorAll('[aria-label],[title]')]
    const target = all.find((el) => {
      const label = (el.getAttribute('aria-label') || '') + '|' + (el.getAttribute('title') || '')
      return label.includes('实时画面') || label.includes('Live Screen') || label.includes('live-screen')
    })
    if (!target) return false
    target.click()
    return true
  })()`)
  check('点到了面板入口', clicked === true)
  await sleep(2500)

  // 3) 主区里应出现画面描述/连接状态文案。
  //    状态词来自 lib/client.js 的 MESSAGES：画面在流 / 未连接 / 连接中（离线也算合法状态）；
  //    工作台版还会显示租约持有者（AI 在操作 / 你或别人在操作 / 无人操作）。
  const panelDom = await evaluate(cdp, `(() => {
    const text = document.body.innerText || ''
    const canvas = document.querySelectorAll('canvas').length
    return {
      canvas,
      hasTitle: text.includes('实时画面') || text.includes('Live Screen'),
      hasState: /画面在流|未连接|连接中|无人操作|AI 在操作|在操作|Streaming|Disconnected|Connecting|Nobody driving/.test(text),
      snippet: text.slice(0, 400)
    }
  })()`)
  console.log('[ui] panel dom =', JSON.stringify(panelDom))
  check('主区出现 canvas（实时画面）', (panelDom?.canvas ?? 0) > 0)
  check('主区出现连接状态文案', panelDom?.hasState === true)
  check('主区出现面板标题', panelDom?.hasTitle === true)

  // 4) 截屏留证。
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const shotPath = path.join(shotDir, 'panel-desktop.png')
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
  console.log('[ui] screenshot =', shotPath, Buffer.from(shot.data, 'base64').length, 'bytes')

  const failed = results.filter((r) => !r.ok)
  console.log(`[ui] ---- ${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} ----`)
  ws.close()
  child.kill()
  process.exit(failed.length === 0 ? 0 : 1)
} catch (error) {
  console.error('[ui] ERROR', error.message)
  child.kill()
  process.exit(3)
}
