/**
 * 控制权租约（ControlLease）。
 *
 * v2 的核心安全机制：AI 与用户争夺同一套输入时，必须有一个明确的「谁在控」。
 * 规则：
 * - 任何一方取得租约后，TTL 内有效（默认 2000ms），需要续期；
 * - 用户产生真实输入（`GetLastInputInfo` 的 idleMs 回落）→ 立即判为抢占，AI 动作返回 `preempted-by-user`；
 * - 用户主动「交还」后，AI 必须重新 snapshot 再规划，不能续上旧计划。
 *
 * 这个类不做 IO，纯状态机，方便单测。
 * @module dsh-live-screen/lease
 */

export const HOLDER_NONE = 'none'
export const HOLDER_AI = 'ai'
export const HOLDER_USER = 'user'

export const ERR_PREEMPTED = 'preempted-by-user'
export const ERR_NOT_HOLDER = 'not-holder'
export const ERR_EXPIRED = 'lease-expired'

export class ControlLease {
  /**
   * @param {object} options
   * @param {number} [options.ttlMs=2000] 租约有效期。
   * @param {number} [options.graceMs=150] 抢占判定的宽限，抵掉采样抖动。
   */
  constructor (options = {}) {
    this.ttlMs = options.ttlMs ?? 2000
    this.graceMs = options.graceMs ?? 150
    this.holder = HOLDER_NONE
    this.expiresAt = 0
    this.lastIdleMs = null
    this.lastSeenAt = 0
    this.preemptedAt = 0
    this.preemptCount = 0
    /**
     * 自注入抑制预算（单位：采样次数，不是毫秒）。
     *
     * `GetLastInputInfo` 分不清「用户按的」和「我们 SendInput 打进去的」：
     * L2 降级动作会让 idleMs 瞬间归零，随后被探针误判成用户抢控制权，
     * AI 打到一半就被自己的动作踢出去。
     *
     * 时间窗在这里是错的：真实的用户动作恰好落在窗口内就会被静默吃掉。
     * 改用计数——每次自注入只消费一次采样，比时间窗精确且不会长期失明。
     */
    this.selfInputBudget = 0
    /** AI 在被用户抢走那一刻的动作序号，供回灌给模型。 */
    this.interruptedActionIndex = -1
  }

  /**
   * 告诉租约：接下来 count 次「刚有输入」的采样是 AI 自己打的，不算抢。
   *
   * 一次点击 = 1 次，一次按键 = 1 次，一次输入 text 按字符数算。
   */
  suppress (count = 1) {
    this.selfInputBudget += Math.max(0, Math.round(count))
    return this.selfInputBudget
  }

  /** 当前有效持有者（过期即降级为 none）。 */
  get current () {
    if (this.holder === HOLDER_NONE) return HOLDER_NONE
    if (Date.now() >= this.expiresAt) {
      this.holder = HOLDER_NONE
      return HOLDER_NONE
    }
    return this.holder
  }

  /** AI 是否可以动手。 */
  canAct () {
    return this.current === HOLDER_AI
  }

  /**
   * AI 申请/续期租约。用户正在动手时不许抢。
   * @returns {{ok:boolean, holder:string, error?:string, ttlMs?:number}}
   */
  acquire (holder = HOLDER_AI) {
    const active = this.current
    if (active === HOLDER_USER) return { ok: false, holder: active, error: ERR_PREEMPTED }
    this.holder = holder
    this.expiresAt = Date.now() + this.ttlMs
    return { ok: true, holder, ttlMs: this.ttlMs }
  }

  /** 续期（只在已持有时有效）。 */
  renew () {
    if (this.current !== HOLDER_AI) return { ok: false, holder: this.current, error: ERR_NOT_HOLDER }
    this.expiresAt = Date.now() + this.ttlMs
    return { ok: true, holder: HOLDER_AI, ttlMs: this.ttlMs }
  }

  /** 显式交还给用户。 */
  release (reason = 'released') {
    this.holder = HOLDER_NONE
    this.expiresAt = 0
    return { ok: true, holder: HOLDER_NONE, reason }
  }

  /**
   * 采样一次宿主上报的 `idleMs`（距用户最后一次真实输入的毫秒数）。
   *
   * 判据必须是「绝对小值」而不是「相对上次回落」：用户闲置 5 秒之后，
   * idleMs 每 100ms 采样都会正常爬升，任何微小回落（5000→4800）都不是动手；
   * 只有 idleMs 真的掉到接近 0，才说明键盘/鼠标刚被按过。
   *
   * @returns {{preempted:boolean, holder:string}}
   */
  observe (idleMs, now = Date.now()) {
    if (typeof idleMs !== 'number' || !Number.isFinite(idleMs)) {
      return { preempted: false, holder: this.current }
    }
    const prev = this.lastIdleMs
    this.lastIdleMs = idleMs
    this.lastSeenAt = now
    if (prev === null) return { preempted: false, holder: this.current }

    // ① 绝对判据：idleMs 接近 0 = 刚刚有输入。
    // ② 兜底：采样稀疏时（设备卡顿/探针被阻塞）从「长闲置」直接跳到「短闲置」，也算动手。
    const touched = idleMs <= this.graceMs
    const dropped = prev >= 1500 && idleMs <= 600
    if (!touched && !dropped) return { preempted: false, holder: this.current }

    // 自注入抑制：这是我们自己 SendInput 打进去的输入，不是用户。
    if (this.selfInputBudget > 0) {
      this.selfInputBudget -= 1
      if (this.holder === HOLDER_AI) this.expiresAt = now + this.ttlMs
      return { preempted: false, holder: this.current }
    }

    if (this.holder === HOLDER_AI) {
      this.preemptedAt = now
      this.preemptCount += 1
      this.holder = HOLDER_USER
      // 用户也有 TTL：他停手一段时间后，AI 才能重新申请。
      this.expiresAt = now + this.ttlMs
      return { preempted: true, holder: HOLDER_USER }
    }
    if (this.holder === HOLDER_USER) {
      // 用户还在动，续期，避免他打字打到一半被 AI 抢回。
      this.expiresAt = now + this.ttlMs
      return { preempted: false, holder: HOLDER_USER }
    }
    this.holder = HOLDER_USER
    this.expiresAt = now + this.ttlMs
    return { preempted: false, holder: HOLDER_USER }
  }

  /** 标记被中断的动作序号，随状态一起回给调用方。 */
  markInterrupted (index) {
    this.interruptedActionIndex = index
  }

  snapshot () {
    const holder = this.current
    return {
      holder,
      canAct: holder === HOLDER_AI,
      ttlMs: this.ttlMs,
      remainingMs: holder === HOLDER_NONE ? 0 : Math.max(0, this.expiresAt - Date.now()),
      idleMs: this.lastIdleMs,
      selfInputBudget: this.selfInputBudget,
      preemptCount: this.preemptCount,
      preemptedAt: this.preemptedAt || null,
      interruptedActionIndex: this.interruptedActionIndex
    }
  }
}
