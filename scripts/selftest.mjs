// 独立验证：不依赖 Harness，直接测采集器 + WebSocket + 动作注入。
// 用法：node scripts/selftest.mjs [--seconds 6]
import { createServer } from 'node:http'
import { ScreenCapture, buildCapture, captureAvailable, EXE_PATH } from '../lib/capture.js'
import { applyAction } from '../lib/actions.js'
import { upgradeToWebSocket } from '../lib/ws.js'

const seconds = Number(process.argv[process.argv.indexOf('--seconds') + 1] || 6) || 6

function log(...args) { console.log('[selftest]', ...args) }

if (!captureAvailable()) {
  log('native exe 缺失，开始编译…')
  await buildCapture()
  log('编译完成', EXE_PATH)
}

const capture = new ScreenCapture({ fps: 12, scale: 1, quality: 55 })

const server = createServer((req, res) => {
  if (req.url.startsWith('/stats')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(capture.stats, null, 2))
    return
  }
  res.writeHead(404); res.end()
})

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return }
  const conn = upgradeToWebSocket(req, socket, head)
  if (!conn) return
  conn.sendText(JSON.stringify({ type: 'hello', ...capture.stats }))
  capture.on('frame', (jpeg) => conn.sendBinary(jpeg))
  conn.on('message', (data, isBinary) => {
    if (isBinary) return
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    if (msg.type === 'ping') { conn.sendText(JSON.stringify({ type: 'pong' })); return }
    const action = msg.type === 'action' ? msg.action : msg
    applyAction(capture, action).then((result) => {
      conn.sendText(JSON.stringify({ type: 'result', result }))
    })
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
log('ws://127.0.0.1:' + port + '/ws')

let frames = 0
let bytes = 0
let firstAt = 0
const startedAt = Date.now()

capture.on('ready', (info) => log('ready', JSON.stringify(info)))
capture.on('frame', (jpeg) => {
  if (!firstAt) { firstAt = Date.now() - startedAt; log('首帧延迟', firstAt, 'ms') }
  frames += 1
  bytes += jpeg.length
})
capture.on('error', (e) => log('error', e.message))
capture.start()

setTimeout(async () => {
  const elapsed = (Date.now() - startedAt) / 1000
  log('frames', frames, 'fps', (frames / elapsed).toFixed(2), 'avgKB', frames ? (bytes / frames / 1024).toFixed(1) : 0)
  log('stats', JSON.stringify(capture.stats))
  const r = await applyAction(capture, { type: 'move', x: 200, y: 200 })
  log('move ->', JSON.stringify(r))
  capture.stop()
  server.close()
  setTimeout(() => process.exit(0), 400)
}, seconds * 1000)
