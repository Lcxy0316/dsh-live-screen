#!/usr/bin/env node
/**
 * 私有桌面（v3 T2）冒烟测试。
 *
 * 验证的是一条完整链路：
 *   DESK NEW  →  DESK SPAWN  →  DESK LIST  →  收合成帧（含子进程窗口）
 *             →  MOVE 更新逻辑光标  →  DESK TAKEOWN / RELEASE  →  DESK CLOSE
 *
 * 全程用户的真实鼠标和前台窗口不该有任何变化 —— 脚本最后会对比前后快照。
 *
 * 用法：node scripts/desk-smoke.mjs [--exe <exe>] [--args <a|b>] [--keep]
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const keep = argv.includes('--keep')

const EXE = opt('exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
const EXE_ARGS = opt('args', '--no-first-run|--no-default-browser-check|about:blank')

let pass = 0
let fail = 0
const ok = (label, detail = '') => { pass++; console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`) }
const no = (label, detail = '') => { fail++; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`) }

/** 读用户桌面状态：光标位置 + 前台窗口标题。用来证明我们没碰用户的东西。 */
function userState() {
  const ps = `
Add-Type -Namespace U -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
'@
$h=[U.W]::GetForegroundWindow()
$sb=New-Object System.Text.StringBuilder 512
[void][U.W]::GetWindowText($h,$sb,512)
$p=[System.Windows.Forms.Cursor]::Position
"@{fg='$($h.ToInt64())'; title='$($sb.ToString())'; x=$p.X; y=$p.Y} | ConvertTo-Json -Compress"`
  const r = spawnSync('pwsh', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.Windows.Forms; ${ps}`], { encoding: 'utf8', timeout: 15000 })
  try { return JSON.parse(r.stdout.trim()) } catch { return null }
}

const binPath = join(root, 'native', 'bin', 'DesktopHost.exe')
if (!existsSync(binPath)) {
  console.error(`missing ${binPath} — 先编译：scripts/build-native.ps1`)
  process.exit(1)
}
if (!existsSync(EXE)) {
  console.error(`目标 exe 不存在：${EXE}（用 --exe 指定别的）`)
  process.exit(1)
}

const before = userState()
console.log(`[desk] 目标 = ${EXE} ${EXE_ARGS.replaceAll('|', ' ')}`)
console.log(`[desk] 用户桌面（前）：fg=${before?.fg} title=${before?.title} cursor=${before?.x},${before?.y}`)

const host = spawn(binPath, ['--fps', '8', '--quality', '60'], { stdio: ['pipe', 'pipe', 'pipe'] })
let stderr = ''
host.stderr.on('data', (d) => { stderr += d.toString() })

// ── 帧/JSON 复用同一个长度前缀流：4 字节小端长度 + 1 字节类型 + 负载（1=JPEG, 2=JSON）──
let buf = Buffer.alloc(0)
const frames = []
const jsonQueue = []
const waiters = []
let lastFrame = null

host.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  while (buf.length >= 5) {
    const len = buf.readUInt32LE(0)
    if (buf.length < 4 + len) break
    const kind = buf[4]
    const payload = buf.subarray(5, 4 + len)
    buf = buf.subarray(4 + len)
    if (kind === 1) {
      // 帧负载 = 16 字节头（seq/ts/w/h/cols/rows/changed）+ JPEG
      lastFrame = { at: Date.now(), bytes: payload.length - 16, data: Buffer.from(payload.subarray(16)) }
      frames.push(lastFrame)
      if (frames.length > 400) frames.shift()
    } else {
      const msg = JSON.parse(payload.toString('utf8'))
      const hit = waiters.findIndex((w) => w.match(msg))
      if (hit >= 0) { const w = waiters.splice(hit, 1)[0]; clearTimeout(w.timer); w.resolve(msg) }
      else jsonQueue.push(msg)
    }
  }
})

function send(line) { host.stdin.write(`${line}\n`) }

/** 发一条命令并等它对应的 JSON 回执（按 type 匹配，超时返回 null）。 */
function call(line, type, timeoutMs = 8000) {
  return new Promise((res) => {
    const w = { match: (m) => m.type === type, resolve: res, timer: null }
    w.timer = setTimeout(() => {
      const i = waiters.indexOf(w)
      if (i >= 0) waiters.splice(i, 1)
      res(null)
    }, timeoutMs)
    waiters.push(w)
    send(line)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const ready = await new Promise((res) => {
    const w = { match: (m) => m.type === 'ready', resolve: res, timer: null }
    w.timer = setTimeout(() => res(null), 10000)
    waiters.push(w)
  })
  if (!ready) { no('host ready'); return }
  ok('host ready', `pid=${ready.pid} fps=${ready.fps}`)

  // 1) 建私有桌面
  const desk = await call('DESK NEW', 'desk', 12000)
  if (!desk) { no('DESK NEW 有回执'); return }
  if (desk.ok) ok('创建私有桌面', `name=${desk.name} hwnd=${desk.hwnd} ${desk.w}x${desk.h}`)
  else { no('创建私有桌面', desk.error); return }

  // 2) 在里面起一个真实应用
  const spawned = await call(`DESK SPAWN ${EXE}|${EXE_ARGS}`, 'spawn', 20000)
  if (spawned?.ok) ok('子进程进入私有桌面', `pid=${spawned.pid}`)
  else no('子进程进入私有桌面', spawned?.error ?? 'no-reply')

  // 3) 等窗口出现（Chromium 起窗要几秒）
  let windows = []
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const list = await call('DESK LIST', 'list', 5000)
    if (list && Array.isArray(list.windows)) {
      windows = list.windows
      if (windows.length > 0) break
    }
    await sleep(700)
  }
  if (windows.length > 0) ok('私有桌面里能看到窗口', `${windows.length} 个：${windows.map((w) => `"${w.title}"`).join(', ')}`)
  else no('私有桌面里能看到窗口', '30 秒内没枚举到')

  // 4) 合成帧：后台桌面没有合成表面，靠逐窗口 PrintWindow 拼，黑屏会很小
  let best = null
  const fdeadline = Date.now() + 15000
  while (Date.now() < fdeadline) {
    if (lastFrame && lastFrame.bytes > 12000) { best = lastFrame; break }
    await sleep(400)
  }
  if (best) {
    const outDir = join(root, 'out')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'desk-frame.jpg'), best.data)
    ok('收到合成帧', `${best.bytes} 字节 → out/desk-frame.jpg（共 ${frames.length} 帧）`)
  } else {
    no('收到合成帧', `最大帧 ${Math.max(0, ...frames.map((f) => f.bytes))} 字节，疑似黑屏`)
  }

  // 5) 逻辑光标：私有桌面里 SendInput 被系统拒（隔离生效），所以光标由我们自己记账
  const moved = await call('MOVE 400 300', 'result', 8000)
  const probe = await call('PROBE', 'probe', 5000)
  if (moved?.ok && probe?.cursor?.virtual && probe.cursor.x === 400 && probe.cursor.y === 300) {
    ok('逻辑光标独立于真实光标', `desk cursor=400,300（真实光标未动）`)
  } else {
    no('逻辑光标独立于真实光标', JSON.stringify({ moved, cursor: probe?.cursor }))
  }
  if (probe?.desk?.bound) ok('工作线程已绑定私有桌面', `desk=${probe.desk.hwnd} pids=${probe.desk.pids}`)
  else no('工作线程已绑定私有桌面', JSON.stringify(probe?.desk ?? null))

  // 6) 接管 / 交还
  const take = await call('DESK TAKEOWN', 'takeover', 10000)
  if (take?.ok && take.active === true) {
    ok('接管：切到私有桌面', '此刻用户能看到虚拟桌面全屏')
    await sleep(1200)
    const rel = await call('DESK RELEASE', 'takeover', 10000)
    if (rel?.ok && rel.active === false) ok('交还：切回用户桌面')
    else no('交还：切回用户桌面', JSON.stringify(rel))
  } else {
    no('接管：切到私有桌面', JSON.stringify(take))
  }

  // 7) 收尾
  if (!keep) {
    const closed = await call('DESK CLOSE', 'deskclosed', 8000)
    if (closed) ok('关闭私有桌面')
    else no('关闭私有桌面', 'no-reply')
  }
}

try {
  await main()
} catch (err) {
  no('意外异常', err?.message ?? String(err))
} finally {
  const after = userState()
  console.log(`[desk] 用户桌面（后）：fg=${after?.fg} title=${after?.title} cursor=${after?.x},${after?.y}`)
  if (before && after) {
    if (before.fg === after.fg && before.x === after.x && before.y === after.y) {
      ok('用户光标与前台窗口全程未被改动')
    } else {
      no('用户光标与前台窗口全程未被改动',
        `fg ${before.fg}→${after.fg}, cursor ${before.x},${before.y}→${after.x},${after.y}`)
    }
  }
  try { send('QUIT') } catch { /* already gone */ }
  await sleep(600)
  if (!host.killed) host.kill()
  if (stderr.trim()) console.log(`[host stderr]\n${stderr.trim().split('\n').slice(-12).join('\n')}`)
  console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`} (${pass} pass / ${fail} fail)`)
  process.exit(fail === 0 ? 0 : 1)
}