// 端到端：直接跑 lib 层的虚拟桌面（不开 Harness）。
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Workspace } from '../lib/workspace.js'
import { hostAvailable, PKG_ROOT } from '../lib/host.js'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const OUT = join(PKG_ROOT, 'out')
const PROF = 'C:\\Users\\7\\AppData\\Local\\Temp\\lsa-e2e'

const pass = []
const fail = []
const check = (ok, label, extra = '') => {
  ;(ok ? pass : fail).push(label)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
}

console.log('native host =', hostAvailable())
const ws = new Workspace({ fps: 10, quality: 60 })
try {
  const opened = await ws.openDesktop({ app: EDGE, appArgs: ['--no-first-run', `--user-data-dir=${PROF}`, 'about:blank'] })
  check(opened.ok === true, '开私有桌面', `${opened.name} ${opened.width}x${opened.height}`)
  check(opened.spawned?.ok === true, '在私有桌面里启动 Edge', opened.spawned?.error ?? '')

  let windows = []
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 700))
    windows = await ws.listWindows()
    if (windows.length) break
  }
  check(windows.length > 0, '私有桌面枚举到窗口', windows.map((w) => w.title).join(' / '))
  check((windows[0]?.title ?? '').includes('Edge'), '枚举到的就是 Edge')

  const frame = await ws.grab()
  check(Boolean(frame), '拿到整桌面合成帧', frame ? `${frame.width}x${frame.height} ${(frame.jpeg.length / 1024).toFixed(0)}KB` : '')
  if (frame) writeFileSync(join(OUT, 'desk-e2e.jpg'), frame.jpeg)

  // 逻辑光标：不应动真实光标
  const moved = await ws.act({ type: 'move', x: 700, y: 400 })
  check(moved.ok === true && moved.detail === 'logical', 'MOVE 走逻辑光标', JSON.stringify(moved))
  const probe = await ws.probeOnce()
  check(probe.cursor?.virtual === true && probe.cursor.x === 700, '探针回报虚拟光标坐标', JSON.stringify(probe.cursor))

  // 点击地址栏（Edge 认 PostMessage）→ 回读应该看到画面变化
  const clicked = await ws.act({ type: 'click', x: 640, y: 82 })
  check(clicked.ok === true, '点击命中窗口', JSON.stringify({ tier: clicked.tier, verified: clicked.verified }))

  // 打字（L2 / SendInput 在非输入桌面会被拒，只有接管后才行）→ 这里只要求如实回报
  const typed = await ws.act({ type: 'type', text: 'lsa' }, { degrade: false })
  check(typed && typeof typed.ok === 'boolean', 'TYPE 有明确回执（不吞错）', JSON.stringify(typed).slice(0, 120))

  // 接管 / 交还
  const taken = await ws.takeover(true)
  check(taken.ok === true && taken.active === true, '接管：把用户屏幕切到私有桌面')
  await new Promise((r) => setTimeout(r, 1200))
  // 接管后 SendInput 才被系统接受（非输入桌面上会被拒），文字这时才真的打得进去
  const typedLive = await ws.act({ type: 'type', text: 'lsa' }, { degrade: false })
  check(typedLive.ok === true && typedLive.detail === 'ok', '接管后打字走 SendInput', JSON.stringify(typedLive).slice(0, 140))
  const released = await ws.takeover(false)
  check(released.ok === true && released.active === false, '交还：切回用户桌面')

  const status = ws.status()
  check(status.desk?.name === opened.name, 'status 里带 desk 信息', JSON.stringify(status.desk))
} catch (error) {
  fail.push(`异常：${error?.message ?? error}`)
  console.log('FAIL 异常', error)
} finally {
  await ws.close()
}

console.log(`\n${fail.length === 0 ? 'ALL PASS' : 'FAILED'} (${pass.length} pass / ${fail.length} fail)`)
process.exit(fail.length === 0 ? 0 : 1)