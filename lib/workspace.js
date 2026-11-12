/**
 * 工作台（Workspace）：一个 DesktopHost 进程 + 一个目标窗口 + 一套租约与回读校验。
 *
 * 和 v1 的差别：
 * - 采集对象是**一个窗口**（`PrintWindow`），不是整屏 → 不抢焦点、不镜像自己；
 * - 动作默认走后台投递（`PostMessage`），失败才降级到前台 `SendInput`；
 * - 每个动作都真回读验证：动作 → 等帧 → 比像素 → 回执里带 `verified`。
 * @module dsh-live-screen/workspace
 */

import { EventEmitter } from 'node:events'
import { DesktopHost, buildHost, hostAvailable } from './host.js'
import { ControlLease, HOLDER_NONE, ERR_PREEMPTED } from './lease.js'

/** 默认参数：单窗口 1280×800 量级，20fps / q70 大约 15Mbps，本地 ws 无压力。 */
export const WORKSPACE_DEFAULTS = {
  fps: 20,
  quality: 70,
  /** 动作后等画面稳定的时间。 */
  settleMs: 220,
  /** 回读验证的超时。 */
  verifyTimeoutMs: 3000,
  /** 多久没有访问就关闭工作台。 */
  idleMs: 60_000
}

let seq = 0

/**
 * 哪些动作值得降级重试。
 *
 * 只有「点/打字/按键」这类预期改变窗口内容的动作，才拿「画面变没变」当成功判据；
 * `move`（本机光标，窗口像素不会变）、`scroll`（可能已经滚到底）、
 * `focus` / `run` / `quality` 本来就与像素无关，硬降级只会把光标抢到你脸上。
 */
const DEGRADABLE = new Set(['click', 'type', 'key'])

function needsDegrade (action) {
  return DEGRADABLE.has(String(action?.type ?? '').toLowerCase())
}

export class Workspace extends EventEmitter {
  constructor (options = {}) {
    super()
    this.id = `ws${++seq}-${Math.random().toString(36).slice(2, 7)}`
    this.options = { ...WORKSPACE_DEFAULTS, ...options }
    this.host = null
    this.lease = new ControlLease({ ttlMs: this.options.leaseTtlMs ?? 2000 })
    this.target = null
    this.spawned = []
    this.lastUsedAt = Date.now()
    this.lastProbe = null
    this.probeTimer = null
    this.closed = false
    this.lastError = null
    this.compiling = null
  }

  get title () {
    return this.target?.title ?? '(未绑定窗口)'
  }

  /** 惰性编译 + 启动宿主。fail-open：失败只记录，不抛。 */
  async ensureHost () {
    if (this.host?.running) return true
    if (!hostAvailable()) {
      this.compiling ??= (async () => {
        try {
          await buildHost()
          return true
        } catch (error) {
          this.lastError = error?.message ?? String(error)
          return false
        }
      })().finally(() => { this.compiling = null })
      if (!await this.compiling) return false
    }
    if (!this.host) {
      this.host = new DesktopHost({ args: ['--fps', String(this.options.fps), '--quality', String(this.options.quality)] })
      this.host.on('frame', (frame) => this.emit('frame', frame))
      this.host.on('exit', (info) => this.emit('host-exit', info))
    }
    if (!this.host.start()) {
      this.lastError = this.host.lastError
      return false
    }
    try {
      await this.host.request(`FPS ${this.options.fps}`, 'fps', 3000)
      await this.host.request(`QUALITY ${this.options.quality}`, 'quality', 3000)
    } catch {}
    return true
  }

  /** 列出所有可绑定窗口。 */
  async listWindows () {
    if (!await this.ensureHost()) return []
    const reply = await this.host.request('LIST', 'list', 6000)
    return reply.windows ?? []
  }

  /**
   * 绑定一个窗口。
   * @param {string|number} selector hwnd（0x.../十进制）或标题片段。
   */
  async open (selector) {
    if (!await this.ensureHost()) return { ok: false, error: this.lastError }
    let hwnd = null
    if (typeof selector === 'number') hwnd = selector
    else if (typeof selector === 'string' && /^(0x)?[0-9a-f]+$/i.test(selector.trim())) hwnd = Number.parseInt(selector.trim(), 16)
    if (hwnd !== null && hwnd > 0) {
      const reply = await this.host.request(`OPEN 0x${hwnd.toString(16)}`, 'opened', 8000)
      if (!reply.ok) return { ok: false, error: reply.error ?? 'open-failed' }
      this.target = { hwnd: `0x${hwnd.toString(16)}`, title: reply.title ?? '', width: reply.w, height: reply.h }
      return { ok: true, ...this.target }
    }
    // 按标题找
    const windows = await this.listWindows()
    const needle = String(selector ?? '').trim()
    const hit = windows.find((w) => w.title && w.title.includes(needle))
    if (!hit) return { ok: false, error: 'window-not-found', query: needle, candidates: windows.slice(0, 12) }
    return await this.open(hit.hwnd)
  }

  /** 绑定整屏（仅调试用；会看到自己）。 */
  async openScreen () {
    if (!await this.ensureHost()) return { ok: false, error: this.lastError }
    const reply = await this.host.request('OPEN SCREEN', 'opened', 8000)
    if (!reply.ok) return { ok: false, error: reply.error ?? 'open-failed' }
    this.target = { hwnd: 'screen', title: '整屏', width: reply.w, height: reply.h }
    return { ok: true, ...this.target }
  }

  /** 启动 100ms 状态探针，喂给租约做抢占检测。 */
  startProbe (intervalMs = 100) {
    if (this.probeTimer) return
    this.probeTimer = setInterval(() => {
      if (!this.host?.running) return
      this.probeOnce().catch(() => {})
    }, intervalMs)
    this.probeTimer.unref?.()
  }

  async probeOnce () {
    const probe = await this.host.request('PROBE', 'probe', 2500)
    this.lastProbe = probe
    const verdict = this.lease.observe(probe.idleMs)
    if (verdict.preempted) this.emit('preempted', { at: Date.now(), probe })
    return probe
  }

  /** 取一帧（可选保存）。 */
  async grab (timeoutMs = 6000) {
    this.touch()
    if (!await this.ensureHost()) return null
    return await this.host.grab(timeoutMs)
  }

  touch () {
    this.lastUsedAt = Date.now()
  }

  /**
   * 执行一个动作并真回读验证。
   *
   * 默认三级降级：先试 L1 后台投递（不动光标、不抢焦点），回读发现画面没变就自动
   * 重试 L2（前台 + SendInput）。只有 L1 生效的动作不会碰你的鼠标。
   *
   * @param {object} action {type, x, y, ...}
   * @param {object} [opts] {verify=true, force=false, degrade=true}
   * @returns {Promise<{ok:boolean, verified?:boolean, changed?:number, error?:string, tier?:string}>}
   */
  async act (action, opts = {}) {
    this.touch()
    if (this.closed) return { ok: false, error: 'workspace-closed' }
    if (!await this.ensureHost()) return { ok: false, error: this.lastError ?? 'host-unavailable' }

    const force = opts.force === true
    const first = await this.#attempt(action, force, opts)
    if (first.ok !== true) return first
    if (force || opts.degrade === false) return first
    // L1 没改像素 → 说明目标窗口不认 PostMessage，降级重试一次。不需要降级的动作
    // （move / scroll / focus / run / quality）由 #needsDegrade 排除。
    if (first.verified === true || !needsDegrade(action)) return first
    if (!this.lease.canAct()) {
      return { ...first, degradeSkipped: ERR_PREEMPTED, lease: this.lease.snapshot() }
    }
    const second = await this.#attempt(action, true, opts)
    if (second.ok !== true) return { ...first, degraded: true, degradeError: second.error }
    return { ...second, degraded: true, l1: { tier: first.tier, verified: first.verified } }
  }

  /** 一次尝试：取前帧 → 动手 → 等 settle → 取后帧 → 比字节。 */
  async #attempt (action, force, opts = {}) {
    const verify = opts.verify !== false
    const before = verify ? await this.host.grab(this.options.verifyTimeoutMs) : null

    const leaseCheck = this.lease.acquire()
    if (!leaseCheck.ok) {
      return { ok: false, error: ERR_PREEMPTED, holder: leaseCheck.holder, lease: this.lease.snapshot() }
    }

    let result
    try {
      // L2（强制前台 + SendInput）会让 GetLastInputInfo 归零，必须提前抑制，
      // 否则探针会在下一拍把 AI 自己的输入当成用户抢占。
      // 只抑制真正走 SendInput 的那几种动作；L1 后台投递完全不碰系统输入队列。
      if (force) this.#suppressSelfInput(action)
      result = await this.#dispatch(action, force)
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) }
    } finally {
      this.lease.renew()
    }

    if (!verify || result.ok !== true) return result

    await new Promise((r) => setTimeout(r, this.options.settleMs))
    const after = await this.host.grab(this.options.verifyTimeoutMs)
    const verified = Boolean(before && after && !before.jpeg.equals(after.jpeg))
    return { ...result, verified, changed: verified ? 1 : 0 }
  }

  /** 批量动作，遇抢占立刻中止并如实报告做到第几个。 */
  async actAll (actions, opts = {}) {
    const results = []
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]
      if (action?.type === 'wait') {
        const ms = Math.max(0, Math.min(10000, Number(action.ms ?? 100) || 0))
        await new Promise((r) => setTimeout(r, ms))
        results.push({ ok: true, type: 'wait', waitMs: ms })
        continue
      }
      const result = await this.act(action, opts)
      results.push(result)
      if (!result.ok && result.error === ERR_PREEMPTED) {
        this.lease.markInterrupted(i)
        results.push({ ok: false, error: ERR_PREEMPTED, interruptedAt: i, remaining: actions.length - i - 1 })
        break
      }
    }
    return { ok: results.every((r) => r.ok), results }
  }

  /**
   * 估算一个 L2 动作会往系统输入队列里塞几次事件，提前记账给租约。
   *
   * 计数必须与实际注入量对齐：多记会让真实用户输入被吃掉一次，
   * 少记会让 AI 被自己的动作踢出控制权。宁少不多 —— 漏一次只导致误抢占，
   * 多一次会让用户按下第一下时没反应。
   */
  #suppressSelfInput (action) {
    const type = String(action?.type ?? '').toLowerCase()
    switch (type) {
      case 'click': {
        // down + up + 一次 SetCursorPos（鼠标移动也算一次真实输入）
        this.lease.suppress(3)
        return
      }
      case 'move':
      case 'scroll':
        this.lease.suppress(1)
        return
      case 'type': {
        // KEYEVENTF_UNICODE 每个字符 down+up
        const chars = String(action?.text ?? '').length
        if (chars > 0) this.lease.suppress(chars * 2)
        return
      }
      case 'key':
        this.lease.suppress(1)
        return
      default:
        // focus / run / quality / probe 不产生输入事件
        return
    }
  }

  /** 把一个动作翻译成宿主命令并发出。 */
  async #dispatch (action, force) {
    if (!this.host?.running) return { ok: false, error: 'host-not-running' }
    const type = String(action?.type ?? '').toLowerCase()
    const suffix = force ? 'F' : ''
    switch (type) {
      case 'click':
      case 'down':
      case 'up': {
        const button = ['right', 'middle'].includes(String(action.button ?? 'left'))
          ? String(action.button)
          : 'left'
        if (type !== 'click') return { ok: false, error: '暂不支持独立 down/up（用 click 或 drag）' }
        const reply = await this.host.request(`CLICK${suffix} ${Math.round(action.x ?? 0)} ${Math.round(action.y ?? 0)} ${button}`, 'result', 4000)
        return { ok: reply.ok === true, tier: reply.tier, detail: reply.detail, x: reply.x, y: reply.y }
      }
      case 'move': {
        const reply = await this.host.request(`MOVE ${Math.round(action.x ?? 0)} ${Math.round(action.y ?? 0)}`, 'result', 4000)
        return { ok: reply.ok === true, detail: reply.detail }
      }
      case 'scroll': {
        const dy = Math.round(Number(action.dy ?? 0))
        const reply = await this.host.request(`SCROLL ${dy}`, 'result', 4000)
        return { ok: reply.ok === true, detail: reply.detail }
      }
      case 'type': {
        const text = String(action.text ?? '')
        if (!text) return { ok: false, error: 'text 为空' }
        const reply = await this.host.request(`TYPE${suffix} ${text}`, 'result', 8000)
        return { ok: reply.ok === true, detail: reply.detail, chars: reply.chars }
      }
      case 'key': {
        const vk = Math.round(Number(action.vk ?? 0))
        const down = action.down !== false
        const reply = await this.host.request(`KEY${suffix} ${vk} ${down ? 'd' : 'u'}`, 'result', 4000)
        return { ok: reply.ok === true, detail: reply.detail }
      }
      case 'focus': {
        const target = String(action.title ?? this.target?.hwnd ?? '')
        if (!target) return { ok: false, error: 'focus 需要 title 或已绑定窗口' }
        const reply = await this.host.request(`FOCUS ${target}`, 'result', 6000)
        return { ok: reply.ok === true, hwnd: reply.hwnd, detail: reply.detail }
      }
      case 'run': {
        const cmd = String(action.cmd ?? '').trim()
        if (!cmd) return { ok: false, error: 'cmd 为空' }
        const reply = await this.host.request(`SPAWN ${cmd}`, 'spawn', 12000)
        if (reply.ok) this.spawned.push(reply.pid)
        return { ok: reply.ok === true, pid: reply.pid, assigned: reply.assigned, error: reply.error }
      }
      case 'quality': {
        const reply = await this.host.request(`QUALITY ${Math.round(action.quality ?? this.options.quality)}`, 'quality', 3000)
        this.options.quality = reply.quality
        return { ok: true, quality: reply.quality }
      }
      case 'probe': {
        const probe = await this.probeOnce()
        return { ok: true, probe }
      }
      default:
        return { ok: false, error: `未知动作类型 ${type}` }
    }
  }

  status () {
    const host = this.host?.stats() ?? { running: false }
    return {
      id: this.id,
      target: this.target,
      lease: this.lease.snapshot(),
      host,
      spawned: this.spawned.slice(),
      lastError: this.lastError,
      closed: this.closed
    }
  }

  async close () {
    if (this.closed) return
    this.closed = true
    clearInterval(this.probeTimer)
    this.probeTimer = null
    try { await this.host?.stop() } catch {}
    this.emit('closed')
  }
}
