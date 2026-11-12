#!/usr/bin/env node
// 工作台（lib/workspace.js）端到端：绑定窗口 → 收帧 → 后台点击 → 回读验证 → 降级 → 租约抢占。
// 不经过 Harness，直接跑 Node 侧全部逻辑。
//   node scripts/verify-workspace.mjs [--app calc] [--title 计算器] [--x 65] [--y 434]
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(PKG_ROOT, 'out')

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }

const app = arg('app', 'calc')
const titleMatch = arg('title', '计算器')
const clickX = arg('x', null)
const clickY = arg('y', null)

const { Workspace } = await import(pathToFileURL(path.join(PKG_ROOT, 'lib', 'workspace.js')).href)
const { ControlLease, HOLDER_AI, ERR_PREEMPTED } = await import(pathToFileURL(path.join(PKG_ROOT, 'lib', 'lease.js')).href)

mkdirSync(OUT, { recursive: true })

const results = []
const record = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 0) 纯状态机单测：ControlLease 抢占逻辑 ───────────────────
{
  const lease = new ControlLease({ ttlMs: 500, graceMs: 100 })
  let v = lease.acquire(HOLDER_AI)
  record('租约：AI 可取', v.ok === true, `holder=${v.holder}`)
  record('租约：AI 可动手', lease.canAct() === true)

  // 用户停手很久 → AI 继续持有
  lease.observe(5000)
  let r = lease.observe(4800)
  record('租约：空闲不误判抢占', r.preempted === false, `holder=${r.holder}`)

  // 用户动了一下 → idleMs 掉到 40
  r = lease.observe(40)
  record('租约：用户动手即抢占', r.preempted === true, `holder=${r.holder}`)
  record('租约：抢占后 AI 不许动手', lease.canAct() === false)

  // AI 想抢回来 → 被拒
  v = lease.acquire(HOLDER_AI)
  record('租约：用户持有时 AI 抢不到', v.ok === false && v.error === ERR_PREEMPTED)

  // 等用户 TTL 过期 → AI 可重新申请
  const expired = new ControlLease({ ttlMs: 60, graceMs: 10 })
  expired.acquire(HOLDER_AI)
  expired.observe(0)
  expired.observe(0)
  record('租约：无新输入时用户态会过期', expired.current !== 'ai')
  await sleep(120)
  record('租约：过期后归 none', expired.current === 'none', `holder=${expired.current}`)
  record('租约：none 状态 AI 可再取', expired.acquire(HOLDER_AI).ok === true)

  // 自注入抑制：AI 自己 SendInput 造成的 idleMs 归零，不能被当成用户抢占
  const self = new ControlLease({ ttlMs: 500, graceMs: 100 })
  self.acquire(HOLDER_AI)
  self.observe(5000)
  self.suppress(3) // 声明接下来 3 次「刚有输入」是我自己打的
  const s1 = self.observe(0)
  const s2 = self.observe(0)
  const s3 = self.observe(0)
  record('租约：自注入不触发抢占', !s1.preempted && !s2.preempted && !s3.preempted, `holder=${s3.holder}`)
  const s4 = self.observe(0) // 预算用尽后的下一次才算用户
  record('租约：抑制预算用尽后恢复敏感', s4.preempted === true, `holder=${s4.holder}`)
}

// ── 1) 起工作台、绑定窗口 ───────────────────────────────────
const ws = new Workspace({ fps: 15, quality: 65 })
let frames = 0
ws.on('frame', () => { frames += 1 })

/** 等租约回到「无人持有」，否则下一次 act 会被正确拒掉。 */
const waitLeaseFree = async (ticks = 40) => {
  for (let i = 0; i < ticks; i++) {
    const holder = ws.lease.current
    if (holder === 'none' || holder === 'ai') return holder
    await sleep(100)
  }
  return ws.lease.current
}

const windows = await ws.listWindows()
record('列出窗口', windows.length > 0, `count=${windows.length}`)
if (windows.length === 0) {
  console.log('没有可见窗口，无法继续')
  await ws.close()
  process.exit(1)
}

// 先确保目标应用在跑
let hit = windows.find((w) => w.title && w.title.includes(titleMatch))
if (!hit) {
  const spawned = await ws.act({ type: 'run', cmd: app }, { verify: false })
  record('启动目标应用', spawned.ok === true, `pid=${spawned.pid}`)
  await sleep(2200)
  hit = (await ws.listWindows()).find((w) => w.title && w.title.includes(titleMatch))
}
record('找到目标窗口', !!hit, hit ? `${hit.hwnd} "${hit.title}" ${hit.rect[2]}×${hit.rect[3]}` : '')
if (!hit) { await ws.close(); process.exit(1) }

const opened = await ws.open(hit.hwnd)
record('绑定窗口', opened.ok === true, `${opened.width}×${opened.height}`)
ws.startProbe()
await sleep(300)

const f1 = await ws.grab()
record('取到窗口帧', !!f1 && f1.jpeg.length > 1000, f1 ? `seq=${f1.seq} ${f1.width}×${f1.height} ${f1.jpeg.length}B` : '')
writeFileSync(path.join(OUT, 'v2-open.jpg'), f1.jpeg)

// ── 2) PROBE + 租约接入真实 idleMs ──────────────────────────
const probe = await ws.probeOnce()
record('PROBE 带 idleMs', typeof probe.idleMs === 'number', `idleMs=${probe.idleMs} fg=${probe.foreground}`)

// ── 3) 点击 + 自动降级 + 回读验证 ───────────────────────────
const cx = clickX !== null ? Number(clickX) : Math.round(f1.width * 0.19)
const cy = clickY !== null ? Number(clickY) : Math.round(f1.height * 0.615)
// 用户此刻可能刚动过鼠标（我们在打命令），先等到租约归 none 再取
for (let i = 0; i < 20 && ws.lease.current !== 'none' && ws.lease.current !== 'ai'; i++) await sleep(120)

// 不传 force：插件自己先试 L1，回读发现没变就自动降级 L2。调用方永远只调一次。
const a1 = await ws.act({ type: 'click', x: cx, y: cy })
record('点击有回执', a1.ok === true, `tier=${a1.tier} detail=${a1.detail}${a1.degraded ? ' (自动降级)' : ''}`)
record('点击最终改动了画面', a1.verified === true, a1.verified ? '画面确实变了' : '画面仍无变化')
if (a1.degraded) {
  record('L1 被记在回执里', a1.l1?.tier === 'L1', JSON.stringify(a1.l1))
} else {
  record('L1 直接生效无需降级', a1.tier === 'L1', `tier=${a1.tier}`)
}

const f2 = await ws.grab()
writeFileSync(path.join(OUT, 'v2-after-click.jpg'), f2.jpeg)
record('点击后仍能取帧', f2.jpeg.length > 1000, `${f2.jpeg.length}B`)

// ── 4) force 时不降级、只读动作不被降级 ────────────────────
const mv = await ws.act({ type: 'move', x: 20, y: 20 })
record('move 走 L1 且不被降级', mv.ok === true && !mv.degraded, `tier=${mv.tier} degraded=${Boolean(mv.degraded)}`)

const forced = await ws.act({ type: 'click', x: cx, y: cy }, { force: true })
record('force 直接走 L2', forced.ok === true && forced.tier === 'L2' && !forced.degraded,
  `tier=${forced.tier} degraded=${Boolean(forced.degraded)} ver=${forced.verified}`)

// ── 5) 批量动作遇抢占能中止 ─────────────────────────────────
// 把租约强行打成「用户持有」，验证后续动作被拒、并且批量立刻停在中途。
ws.lease.release('test')
ws.lease.selfInputBudget = 0
ws.lease.acquire(HOLDER_AI)
ws.lease.observe(5000)
const verdict = ws.lease.observe(5) // 用户刚动手
record('手动制造抢占', verdict.preempted === true, `holder=${verdict.holder}`)
const batch = await ws.actAll([{ type: 'move', x: 10, y: 10 }, { type: 'move', x: 20, y: 20 }])
record('抢占后批量动作被拒', batch.ok === false, JSON.stringify(batch.results?.[0] ?? {}))
record('抢占错误码正确', batch.results?.[0]?.error === ERR_PREEMPTED)
record('批量如实报告剩余', batch.results?.[1]?.remaining === 1)

// ── 6) 状态与内存 ───────────────────────────────────────────
const status = ws.status()
record('status 报出宿主', status.host.running === true, `frames=${status.host.frames} rss=${status.host.rssMB}MB avg=${status.host.avgKB}KB`)
record('status 报出 target', status.target?.hwnd === hit.hwnd)

await ws.close()
record('关闭工作台', ws.closed === true)

const pass = results.filter((r) => r.ok).length
console.log(`\n== ${pass}/${results.length} PASS, frames=${frames}`)
process.exit(pass === results.length ? 0 : 1)
