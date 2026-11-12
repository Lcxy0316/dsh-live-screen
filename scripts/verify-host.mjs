// 不启动 Harness 的宿主半边验证：
// 用 module.registerHooks 复刻 Harness 的 @deepseek-ai/* 解析（安装目录），
// 给插件一个最小 ctx（tools / attachments / inject / effect / get），
// 然后把 mock webServer 的注册接到一个真实 http server 上跑端到端。
//
// 用法：node scripts/verify-host.mjs
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const INSTALL_MODULES = 'C:\\Users\\7\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app\\dsh\\node_modules'
const HARNESS_ONLY = /^@deepseek-ai\//

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (HARNESS_ONLY.test(specifier)) {
      const base = join(INSTALL_MODULES, ...specifier.split('/'))
      const pkgPath = join(base, 'package.json')
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        const target = pkg.exports?.['.']?.default ?? pkg.exports?.['.'] ?? pkg.main ?? 'lib/index.js'
        const entry = join(base, typeof target === 'string' ? target : 'lib/index.js')
        if (existsSync(entry)) return { url: pathToFileURL(entry).href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  },
})

const log = (...a) => console.log('[verify]', ...a)
let failures = 0
function check(name, ok, detail) {
  if (ok) log('PASS', name)
  else { failures += 1; log('FAIL', name, detail ?? '') }
}

const mod = await import('../lib/index.js')
check('模块导出 name', mod.name === 'live-screen', mod.name)
check('模块导出 inject', Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject))
check('导出 apply', typeof mod.apply === 'function')
check('导出 isAvailable', typeof mod.isAvailable === 'function' && mod.isAvailable() === true)

/* ---------------- 假 ctx ---------------- */
const registered = { tools: [], http: [], upgrade: [], effects: [], injected: [] }

const fakeWebServer = {
  port: 0,
  protocol: 'http:',
  getOrigin() { return 'http://127.0.0.1:0' },
  register(route) { registered.http.push(route); return () => { registered.http = registered.http.filter((r) => r !== route) } },
  registerUpgrade(route) { registered.upgrade.push(route); return () => { registered.upgrade = registered.upgrade.filter((r) => r !== route) } },
}

const fakeCtx = {
  tools: { register(tool) { registered.tools.push(tool); return () => {} } },
  attachments: { async saveImage(args) { return { attachmentId: 'att_test', mediaType: args.mediaType, bytes: args.data.length, width: 0, height: 0, name: args.name } } },
  inject(names, cb) {
    registered.injected.push(names)
    const routeCtx = {
      get(name) { return name === 'webServer' ? fakeWebServer : undefined },
      effect(fn, label) { const dispose = fn(); registered.effects.push({ label, dispose }); return dispose },
    }
    cb(routeCtx)
  },
  effect(fn, label) { const dispose = fn(); registered.effects.push({ label, dispose }); return dispose },
}

mod.apply(fakeCtx, { fps: 12, scale: 1, quality: 55 })

check('注册了工具', registered.tools.length === 1, String(registered.tools.length))
check('工具名 live_screen', registered.tools[0]?.name === 'live_screen', registered.tools[0]?.name)
check('注入 webServer', registered.injected.some((n) => n.includes('webServer')))
check('注册了 http 路由', registered.http.length === 1 && registered.http[0].kind === 'prefix', JSON.stringify(registered.http.map((r) => r.kind)))
check('注册了 ws 升级路由', registered.upgrade.length === 1, JSON.stringify(registered.upgrade.map((r) => r.path)))
check('ws 路径', registered.upgrade[0]?.path === '/live-screen/ws', registered.upgrade[0]?.path)

/* ---------------- 接到真实 http server ---------------- */
const server = createServer((req, res) => {
  const route = registered.http[0]
  if (route && new URL(req.url, 'http://x').pathname.startsWith(route.path)) { route.handler(req, res); return }
  res.writeHead(404); res.end()
})
server.on('upgrade', (req, socket, head) => {
  const route = registered.upgrade.find((r) => r.path === new URL(req.url, 'http://x').pathname)
  if (!route) { socket.destroy(); return }
  route.handler(req, socket, head)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
log('listening', port)

const json = async (path) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: res.status, body: await res.text() }
}

const screen = await json('/live-screen/screen')
check('GET /screen 200', screen.status === 200, String(screen.status))
log('  screen =', screen.body)

const snapRes = await fetch(`http://127.0.0.1:${port}/live-screen/snapshot`)
const snapBuf = Buffer.from(await snapRes.arrayBuffer())
check('GET /snapshot 200', snapRes.status === 200, String(snapRes.status))
check('snapshot 是 JPEG', snapBuf[0] === 0xff && snapBuf[1] === 0xd8, snapBuf.subarray(0, 2).toString('hex'))
check('snapshot 体积合理', snapBuf.length > 20000, String(snapBuf.length))
log('  snapshot bytes =', snapBuf.length)

const actRes = await fetch(`http://127.0.0.1:${port}/live-screen/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify([{ type: 'move', x: 640, y: 400 }, { type: 'wait', ms: 60 }]),
})
const actBody = await actRes.text()
check('POST /action 200', actRes.status === 200, String(actRes.status))
check('action 结果 ok', actBody.includes('"ok":true'), actBody)
log('  action =', actBody)

const statsRes = await json('/live-screen/stats')
check('GET /stats 200', statsRes.status === 200, String(statsRes.status))
log('  stats =', statsRes.body.slice(0, 200))

/* ---------------- WebSocket ---------------- */
const ws = new WebSocket(`ws://127.0.0.1:${port}/live-screen/ws`)
ws.binaryType = 'arraybuffer'
const wsFrames = []
const wsTexts = []
let firstFrameAt = 0
const wsStart = Date.now()

const wsDone = new Promise((resolve) => {
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') { wsTexts.push(JSON.parse(event.data)); return }
    if (!firstFrameAt) firstFrameAt = Date.now() - wsStart
    wsFrames.push(event.data.byteLength)
    if (wsFrames.length >= 20) resolve()
  }
  ws.onerror = () => resolve()
  ws.onclose = () => resolve()
  setTimeout(resolve, 8000)
})
await wsDone
check('收到 hello', wsTexts.some((m) => m.type === 'hello'), JSON.stringify(wsTexts.slice(0, 2)))
check('收到 >= 20 帧', wsFrames.length >= 20, String(wsFrames.length))
check('首帧 < 1500ms', firstFrameAt > 0 && firstFrameAt < 1500, String(firstFrameAt) + 'ms')
if (wsFrames.length) {
  const avg = wsFrames.reduce((a, b) => a + b, 0) / wsFrames.length
  log('  帧数', wsFrames.length, '首帧', firstFrameAt, 'ms', '平均', (avg / 1024).toFixed(1), 'KB')
}

// WS 上行动作
const ack = new Promise((resolve) => {
  const prev = ws.onmessage
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const m = JSON.parse(event.data)
      if (m.type === 'result') { ws.onmessage = prev; resolve(m) }
    }
    prev(event)
  }
  setTimeout(() => resolve(null), 3000)
})
ws.send(JSON.stringify({ type: 'action', action: { type: 'move', x: 300, y: 300 } }))
const ackMsg = await ack
check('WS 上行动作有 result 回包', ackMsg !== null && ackMsg.result?.ok === true, JSON.stringify(ackMsg))

ws.close()

/* ---------------- 工具执行 ---------------- */
const tool = registered.tools[0]
const statsOut = await tool.execute({ action: 'stats' })
check('工具 stats ok', statsOut.ok === true && !!statsOut.stats, JSON.stringify(statsOut).slice(0, 160))

const snapOut = await tool.execute({ action: 'snapshot' })
check('工具 snapshot ok', snapOut.ok === true, JSON.stringify(snapOut).slice(0, 200))
check('工具 snapshot 返回 image attachment', Array.isArray(snapOut.attachments) && snapOut.attachments.length === 1,
  JSON.stringify(snapOut.attachments))
const rendered = tool.output.render({ action: 'snapshot' }, snapOut)
check('render 含 image 段', rendered.some((p) => p.type === 'image'), JSON.stringify(rendered.map((p) => p.type)))
check('render 含 text 段', rendered.some((p) => p.type === 'text'))

const actOut = await tool.execute({ action: 'action', steps: [{ type: 'move', x: 500, y: 500 }] })
check('工具 action ok', actOut.ok === true && actOut.results?.[0]?.ok === true, JSON.stringify(actOut).slice(0, 200))

/* ---------------- 清理 ---------------- */
server.close()
for (const effect of registered.effects) { try { effect.dispose() } catch {} }

log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
