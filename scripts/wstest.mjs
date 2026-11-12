// 裸 WS 压测：连上 /live-screen/ws，统计帧数、fps、码率、首帧延迟。
// 用法：node scripts/wstest.mjs [ws://127.0.0.1:52199/live-screen/ws] [seconds]
const url = process.argv[2] ?? 'ws://127.0.0.1:52199/live-screen/ws'
const seconds = Number(process.argv[3] ?? 6)

const ws = new WebSocket(url)
ws.binaryType = 'arraybuffer'

let frames = 0
let bytes = 0
let firstAt = 0
const t0 = Date.now()
let hello = null

ws.addEventListener('open', () => console.log('[ws] open', url))
ws.addEventListener('message', (event) => {
  if (typeof event.data === 'string') {
    const msg = JSON.parse(event.data)
    if (msg.type === 'hello') {
      hello = msg
      console.log('[ws] hello', JSON.stringify(msg))
    } else {
      console.log('[ws] text', event.data.slice(0, 200))
    }
    return
  }
  frames += 1
  bytes += event.data.byteLength
  if (!firstAt) {
    firstAt = Date.now()
    console.log('[ws] first frame after', firstAt - t0, 'ms', event.data.byteLength, 'bytes')
  }
})

setTimeout(() => {
  const elapsed = (Date.now() - t0) / 1000
  console.log('[ws] ---- result ----')
  console.log('hello      =', hello ? `${hello.width}x${hello.height} src ${hello.srcWidth}x${hello.srcHeight}` : 'none')
  console.log('frames     =', frames)
  console.log('elapsed    =', elapsed.toFixed(2), 's')
  console.log('fps        =', (frames / elapsed).toFixed(2))
  console.log('avg bytes  =', frames ? Math.round(bytes / frames) : 0)
  console.log('mbps       =', ((bytes * 8) / elapsed / 1e6).toFixed(2))
  ws.close(1000, 'done')
  setTimeout(() => process.exit(0), 200)
}, seconds * 1000)
