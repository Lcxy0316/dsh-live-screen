// 不启动 Harness 的宿主半边验证（v2 工作台版）：
// 用 module.registerHooks 复刻 Harness 的 @deepseek-ai/* 解析（安装目录），
// 给插件一个最小 ctx（tools / attachments / inject / effect），
// 然后把 mock webServer 的注册接到真实 http server 上跑端到端。
//
// 覆盖：注册形状 → 工具（list/open/snapshot/act/lease/stats/close）→
//       HTTP（workspaces/snapshot/status/lease/act/windows/list DELETE）→
//       WS（hello / 出帧 / act 回执 / status / windows / open）→ 空闲回收。
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const mod = await import('../lib/index.js')
check('模块导出 name', mod.name === 'live-screen', mod.name)
check('模块导出 inject', Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject))
check('导出 apply', typeof mod.apply === 'function')
check('导出 isAvailable', typeof mod.isAvailable === 'function' && mod.isAvailable() === true)
check('原生宿主已编译', existsSync(mod.HOST_EXE), mod.HOST_EXE)

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

const IDLE_MS = 2500
mod.apply(fakeCtx, { fps: 12, quality: 60, idleMs: IDLE_MS, leaseTtlMs: 2000 })

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
const base = `http://127.0.0.1:${port}/live-screen`
log('listening', port)

const getJson = async (path, init) => {
  const res = await fetch(`${base}${path}`, init)
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch {}
  return { status: res.status, body, text }
}
const postJson = (path, payload) => getJson(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload)
})

/* ---------------- 挑一个真实窗口 ---------------- */
const listRes = await getJson('/list')
check('GET /list 200', listRes.status === 200, String(listRes.status))
const windows = listRes.body?.windows ?? []
check('列出窗口 >= 1', windows.length >= 1, String(windows.length))
log('  可见窗口', windows.slice(0, 6).map((w) => `${w.hwnd} ${w.title} ${w.rect?.[2]}x${w.rect?.[3]}`).join(' | '))

// 优先挑一个能改画面的目标：记事本 > 计算器 > 任意足够大的窗口。
const pick = windows.find((w) => /记事本|Notepad/i.test(w.title ?? ''))
  ?? windows.find((w) => /计算器|Calculator/i.test(w.title ?? ''))
  ?? windows.find((w) => (w.rect?.[2] ?? 0) >= 300 && (w.rect?.[3] ?? 0) >= 300)
  ?? windows[0]
check('找到可绑定窗口', !!pick, JSON.stringify(windows.slice(0, 3)))
if (!pick) { server.close(); process.exit(1) }
log('  目标窗口', pick.hwnd, JSON.stringify(pick.title), `${pick.rect?.[2]}x${pick.rect?.[3]}`)

/* ---------------- 工具：open ---------------- */
const tool = registered.tools[0]
const toolListOut = await tool.execute({ action: 'list' })
check('工具 list ok', toolListOut.ok === true && toolListOut.windows?.length >= 1, JSON.stringify(toolListOut).slice(0, 160))

const openOut = await tool.execute({ action: 'open', window: pick.hwnd })
check('工具 open ok', openOut.ok === true, JSON.stringify(openOut).slice(0, 240))
const wsA = openOut.workspace
check('open 返回工作台 id', typeof wsA === 'string' && wsA.startsWith('ws'), wsA)
check('open 报出目标尺寸', openOut.target?.width > 0 && openOut.target?.height > 0, JSON.stringify(openOut.target))
log('  workspace', wsA, 'target', JSON.stringify(openOut.target))

// 渲染
const openRendered = tool.output.render({ action: 'open' }, openOut)
check('render open 有 text 段', openRendered.some((p) => p.type === 'text'))

/* ---------------- 工具：snapshot ---------------- */
const snapOut = await tool.execute({ action: 'snapshot' })
check('工具 snapshot ok', snapOut.ok === true, JSON.stringify(snapOut).slice(0, 200))
check('snapshot 带 image attachment', snapOut.attachments?.length === 1, JSON.stringify(snapOut.attachments))
check('snapshot 尺寸与绑定窗口一致',
  snapOut.width === openOut.target.width && snapOut.height === openOut.target.height,
  `${snapOut.width}x${snapOut.height} vs ${openOut.target.width}x${openOut.target.height}`)
check('snapshot 体积合理', snapOut.bytes > 2000, String(snapOut.bytes))
const snapRendered = tool.output.render({ action: 'snapshot' }, snapOut)
check('render snapshot 含 image 段', snapRendered.some((p) => p.type === 'image'), JSON.stringify(snapRendered.map((p) => p.type)))
check('render snapshot 含 text 段', snapRendered.some((p) => p.type === 'text'))
log('  snapshot', `${snapOut.width}x${snapOut.height}`, `${(snapOut.bytes / 1024).toFixed(1)}KB`, 'seq', snapOut.seq)

/* ---------------- 工具：act（真回读） ---------------- */
const actOut = await tool.execute({
  action: 'act',
  steps: [
    { type: 'click', x: Math.round(openOut.target.width / 2), y: Math.round(openOut.target.height / 2) },
    { type: 'wait', ms: 60 },
  ],
})
check('工具 act ok', actOut.ok === true, JSON.stringify(actOut).slice(0, 240))
const firstAct = actOut.results?.[0]
check('act 回执带 tier', typeof firstAct?.tier === 'string', JSON.stringify(firstAct))
check('act 回执带 verified 布尔', typeof firstAct?.verified === 'boolean', JSON.stringify(firstAct))
check('act 回执带 lease', typeof actOut.lease?.holder === 'string', JSON.stringify(actOut.lease))
const actRendered = tool.output.render({ action: 'act' }, actOut)
check('render act 标注回读结果',
  /已回读确认|画面无变化/.test(actRendered[0]?.text ?? '') || actRendered[0]?.text?.length > 0,
  actRendered[0]?.text)
log('  act', JSON.stringify(firstAct))

/* ---------------- 工具：lease ---------------- */
const leaseOut = await tool.execute({ action: 'lease' })
check('工具 lease 返回租约', typeof leaseOut.lease?.holder === 'string', JSON.stringify(leaseOut.lease).slice(0, 200))

/* ---------------- 工具：stats ---------------- */
const toolStats = await tool.execute({ action: 'stats' })
check('工具 stats ok', toolStats.ok === true && Array.isArray(toolStats.stats?.workspaces), JSON.stringify(toolStats).slice(0, 160))
check('stats 报出原生宿主可用', toolStats.stats?.nativeHost?.available === true, JSON.stringify(toolStats.stats?.nativeHost))

/* ---------------- 工具：close ---------------- */
const closeOut = await tool.execute({ action: 'close', workspace: wsA })
check('工具 close ok', closeOut.ok === true, JSON.stringify(closeOut).slice(0, 160))
await sleep(400)
const afterClose = await getJson('/stats')
check('close 后工作台已移除', (afterClose.body?.workspaces ?? []).length === 0, JSON.stringify(afterClose.body?.workspaces?.map((w) => w.id)))

/* ---------------- HTTP：工作台生命周期 ---------------- */
const createRes = await postJson('/workspaces', { window: pick.hwnd, fps: 12, quality: 60 })
check('POST /workspaces 200', createRes.status === 200, `${createRes.status} ${createRes.text.slice(0, 160)}`)
const wsB = createRes.body?.id
check('返回工作台 id', typeof wsB === 'string', String(wsB))

const stRes = await getJson(`/${wsB}/status`)
check('GET /<id>/status 200', stRes.status === 200, String(stRes.status))
check('status 报出宿主在跑', stRes.body?.host?.running === true, JSON.stringify(stRes.body?.host).slice(0, 200))

const snapRes = await fetch(`${base}/${wsB}/snapshot`)
const snapBuf = Buffer.from(await snapRes.arrayBuffer())
check('GET /<id>/snapshot 200', snapRes.status === 200, String(snapRes.status))
check('snapshot 是 JPEG', snapBuf[0] === 0xff && snapBuf[1] === 0xd8, snapBuf.subarray(0, 2).toString('hex'))
check('snapshot 带 seq 头', Number(snapRes.headers.get('x-frame-seq')) > 0, String(snapRes.headers.get('x-frame-seq')))
log('  snapshot', snapBuf.length, 'B seq', snapRes.headers.get('x-frame-seq'))

// 帧计数要在出过帧之后再看：静态窗口分块哈希不变时不编码，frames 本来就是 0。
const stAfter = await getJson(`/${wsB}/status`)
const hostStats = stAfter.body?.host ?? {}
check('status 报出帧数与均帧大小', hostStats.frames > 0 && hostStats.avgKB > 0, JSON.stringify(hostStats).slice(0, 220))
log('  host', { frames: hostStats.frames, avgKB: hostStats.avgKB, rssMB: hostStats.rssMB })

const leaseRes = await getJson(`/${wsB}/lease`)
check('GET /<id>/lease 200', leaseRes.status === 200 && typeof leaseRes.body?.holder === 'string', JSON.stringify(leaseRes.body).slice(0, 160))

const actRes = await postJson(`/${wsB}/act`, { type: 'move', x: 40, y: 40 })
check('POST /<id>/act 200', actRes.status === 200, String(actRes.status))
check('act 回执 ok', actRes.body?.ok === true, JSON.stringify(actRes.body).slice(0, 200))

const windowsRes = await getJson('/windows')
check('GET /windows 200', windowsRes.status === 200, String(windowsRes.status))
check('/windows 复用已有工作台', windowsRes.body?.reused === wsB, JSON.stringify(windowsRes.body?.reused))

const listAfter = await getJson('/stats')
check('/stats 列出工作台', (listAfter.body?.workspaces ?? []).some((w) => w.id === wsB), JSON.stringify(listAfter.body?.workspaces?.map((w) => w.id)))

/* ---------------- WebSocket ---------------- */
const wsUrl = `ws://127.0.0.1:${port}/live-screen/ws?id=${wsB}`
const ws = new WebSocket(wsUrl)
ws.binaryType = 'arraybuffer'
const wsTexts = []
const wsFrames = []
const wsStart = Date.now()
let firstFrameAt = 0

const wsDone = new Promise((resolve) => {
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') { wsTexts.push(JSON.parse(event.data)); return }
    if (!firstFrameAt) firstFrameAt = Date.now() - wsStart
    wsFrames.push(event.data.byteLength)
  }
  ws.onerror = () => resolve()
  ws.onclose = () => resolve()
  setTimeout(resolve, 3000)
})
await wsDone
check('WS 收到 hello', wsTexts.some((m) => m.type === 'hello'), JSON.stringify(wsTexts.slice(0, 2)))
const hello = wsTexts.find((m) => m.type === 'hello')
check('hello 带工作台 id', hello?.workspaceId === wsB, String(hello?.workspaceId))
check('hello 报出宿主状态', hello?.host?.running === true, JSON.stringify(hello?.host).slice(0, 160))
check('WS 首帧到达', wsFrames.length >= 1, JSON.stringify(wsFrames))
check('WS 首帧 < 3000ms', firstFrameAt > 0 && firstFrameAt < 3000, `${firstFrameAt}ms`)
if (wsFrames.length) log('  ws frames', wsFrames.length, '首帧', firstFrameAt, 'ms', '平均', (wsFrames.reduce((a, b) => a + b, 0) / wsFrames.length / 1024).toFixed(1), 'KB')

// 静态窗口默认不产帧（分块哈希去重），主动 grab 会强制出一帧并广播给 watcher。
const framesBefore = wsFrames.length
for (let i = 0; i < 3; i++) {
  await fetch(`${base}/${wsB}/snapshot`).then((r) => r.arrayBuffer())
  await sleep(120)
}
check('强制快照会广播新帧', wsFrames.length > framesBefore, `${framesBefore} → ${wsFrames.length}`)

const waitText = (predicate, timeoutMs = 4000) => new Promise((resolve) => {
  const timer = setInterval(() => {
    const hit = wsTexts.find(predicate)
    if (hit) { clearInterval(timer); resolve(hit) }
  }, 40)
  setTimeout(() => { clearInterval(timer); resolve(null) }, timeoutMs)
})

const mark = wsTexts.length
ws.send(JSON.stringify({ type: 'windows' }))
const windowsMsg = await waitText((m) => m.type === 'windows')
check('WS windows 返回窗口清单', Array.isArray(windowsMsg?.windows) && windowsMsg.windows.length >= 1, JSON.stringify(windowsMsg).slice(0, 160))

ws.send(JSON.stringify({ type: 'act', action: { type: 'move', x: 30, y: 30 } }))
const actMsg = await waitText((m) => m.type === 'result')
check('WS act 有 result 回包', actMsg?.result?.ok === true, JSON.stringify(actMsg).slice(0, 200))
check('WS act 回执带 verified', typeof actMsg?.result?.verified === 'boolean', JSON.stringify(actMsg?.result).slice(0, 160))

ws.send(JSON.stringify({ type: 'lease-acquire' }))
const leaseMsg = await waitText((m) => m.type === 'lease')
check('WS lease-acquire 回包', typeof leaseMsg?.holder === 'string', JSON.stringify(leaseMsg).slice(0, 160))

ws.send(JSON.stringify({ type: 'status' }))
const statusMsg = await waitText((m) => m.type === 'status')
check('WS status 回包', statusMsg?.host !== undefined, JSON.stringify(statusMsg).slice(0, 160))

ws.send(JSON.stringify({ type: 'open', hwnd: pick.hwnd }))
const openedMsg = await waitText((m) => m.type === 'opened')
check('WS open 回包', openedMsg?.ok === true, JSON.stringify(openedMsg).slice(0, 200))
check('WS 消息序列有新增', wsTexts.length > mark, `${mark} → ${wsTexts.length}`)

ws.close()
await sleep(300)

/* ---------------- 空闲回收 ---------------- */
const beforeReap = (await getJson('/stats')).body?.workspaces ?? []
check('回收前工作台存在', beforeReap.some((w) => w.id === wsB), JSON.stringify(beforeReap.map((w) => w.id)))
log(`  等待 ${IDLE_MS}ms 空闲 + 回收周期…`)
await sleep(IDLE_MS + 6500)
const afterReap = (await getJson('/stats')).body?.workspaces ?? []
check('空闲超时后工作台被回收', !afterReap.some((w) => w.id === wsB), JSON.stringify(afterReap.map((w) => w.id)))

/* ---------------- 清理 ---------------- */
server.close()
for (const effect of registered.effects) { try { effect.dispose() } catch {} }
await sleep(500)

log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
