#!/usr/bin/env node
// DesktopHost.exe 协议冒烟测试：不依赖 DSH，直接 spawn 原生宿主，发命令、收帧、打印 JSON。
//   node scripts/probe-host.mjs                    → OPEN SCREEN + 收 3 帧 + METRICS
//   node scripts/probe-host.mjs --hwnd 0x1a2b      → 打开指定窗口
//   node scripts/probe-host.mjs --script "LIST|OPEN SCREEN|PROBE"   → 自定义命令序列
//   node scripts/probe-host.mjs --seconds 5        → 停留时长
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(PKG_ROOT, 'native', 'bin', 'DesktopHost.exe')

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}

if (!existsSync(EXE)) {
  console.error(`[probe-host] 缺少 ${EXE}\n  先跑: pwsh -File scripts/build-native.ps1`)
  process.exit(1)
}

const target = arg('hwnd', 'SCREEN')
const seconds = Number(arg('seconds', '4'))
const script = arg('script', null)
const saveFrame = arg('out', path.join(PKG_ROOT, 'out', 'desktophost-frame.jpg'))

const child = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

let buf = Buffer.alloc(0)
let frames = 0
let bytes = 0
let firstFrameAt = 0
const started = Date.now()
const seen = []

child.stdout.on('data', (chunk) => {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
  for (;;) {
    if (buf.length < 4) return
    const len = buf.readUInt32LE(0)
    if (buf.length < 4 + len) return
    const type = buf[4]
    const payload = buf.subarray(5, 4 + len)
    buf = buf.subarray(4 + len)

    if (type === 1) {
      // 帧: seq u32, tsMs u32, w u16, h u16, cols u8, rows u8, changedTiles u16, jpeg...
      if (payload.length < 16) continue
      const seq = payload.readUInt32LE(0)
      const ts = payload.readUInt32LE(4)
      const w = payload.readUInt16LE(8)
      const h = payload.readUInt16LE(10)
      const cols = payload[12], rows = payload[13]
      const changed = payload.readUInt16LE(14)
      const jpeg = payload.subarray(16)
      frames += 1
      bytes += jpeg.length
      if (!firstFrameAt) firstFrameAt = Date.now() - started
      if (frames === 1) {
        console.log(`[frame#${seq}] ${w}x${h} tiles=${cols}x${rows} changed=${changed} bytes=${jpeg.length} ts=${ts}ms`)
        if (saveFrame) {
          mkdirSync(path.dirname(saveFrame), { recursive: true })
          writeFileSync(saveFrame, jpeg)
          console.log(`[frame] saved → ${saveFrame}`)
        }
      }
    } else if (type === 2) {
      const text = payload.toString('utf8')
      seen.push(text)
      console.log(`[json] ${text.length > 600 ? text.slice(0, 600) + '…' : text}`)
    }
  }
})

child.stderr.on('data', (d) => process.stderr.write(`[stderr] ${d}`))
child.on('exit', (code) => {
  console.log(`\n[exit] code=${code} frames=${frames} bytes=${bytes} firstFrameMs=${firstFrameAt}`)
  if (frames > 1) {
    console.log(`[rate] avg ${(bytes / frames / 1024).toFixed(1)} KB/frame`)
  }
})

const send = (line) => {
  console.log(`> ${line}`)
  child.stdin.write(line + '\n')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const main = async () => {
  await sleep(250)
  if (script) {
    for (const raw of script.split('|')) {
      const line = raw.trim()
      if (!line) continue
      send(line.startsWith('OPEN ') && target !== 'SCREEN' ? `OPEN ${target}` : line)
      await sleep(700)
    }
  } else {
    send(`OPEN ${target}`)
    await sleep(900)
    send('METRICS')
    await sleep(300)
    send('PROBE')
    await sleep(300)
    send('FRAME')
  }
  await sleep(Math.max(800, seconds * 1000))
  send('METRICS')
  await sleep(400)
  send('QUIT')
  setTimeout(() => { try { child.kill() } catch {} process.exit(0) }, 1500)
}

main()
