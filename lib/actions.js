// 统一动作分发：把结构化动作翻译成采集器的文本控制协议。
// 工具、HTTP 路由、WebSocket 上行三条通路共用这一份实现，
// 保证「AI 点击」和「人手点击」走的是同一条代码路径。

const BUTTONS = { left: 'l', right: 'r', middle: 'm' }

function button (value) {
  return BUTTONS[value] ?? 'l'
}

function int (value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : null
}

/**
 * 执行一个动作。
 * @param capture - ScreenCapture 实例。
 * @param action - 动作对象，`type` 必填。
 * @returns {{ok: boolean, error?: string}} 单动作结果。
 */
export function applyAction (capture, action) {
  if (!action || typeof action !== 'object') return { ok: false, error: '动作必须是对象' }
  const type = String(action.type ?? '')
  switch (type) {
    case 'move': {
      const x = int(action.x); const y = int(action.y)
      if (x === null || y === null) return { ok: false, error: 'move 需要 x/y' }
      return { ok: capture.command(`MV ${x} ${y}`) }
    }
    case 'click': {
      const x = int(action.x); const y = int(action.y)
      if (x === null || y === null) return { ok: false, error: 'click 需要 x/y' }
      const b = button(action.button)
      const count = Math.max(1, Math.min(3, int(action.count) ?? 1))
      let ok = true
      for (let i = 0; i < count; i++) ok = capture.command(`CL ${x} ${y} ${b}`) && ok
      return { ok }
    }
    case 'down':
      return { ok: capture.command(`DN ${button(action.button)}`) }
    case 'up':
      return { ok: capture.command(`UP ${button(action.button)}`) }
    case 'scroll': {
      const dy = int(action.dy) ?? 0
      return { ok: capture.command(`SC ${dy}`) }
    }
    case 'type':
      return { ok: capture.command(`TX ${String(action.text ?? '')}`) }
    case 'key': {
      const vk = int(action.vk)
      if (vk === null) return { ok: false, error: 'key 需要 vk' }
      return { ok: capture.command(`KY ${vk} ${action.down ? 'd' : 'u'}`) }
    }
    case 'focus':
      return { ok: capture.command(`FOCUS ${String(action.title ?? '')}`) }
    case 'run':
      return { ok: capture.command(`RUN ${String(action.cmd ?? '')}`) }
    case 'quality': {
      const quality = Math.max(20, Math.min(90, int(action.quality) ?? 55))
      return { ok: capture.setQuality(quality) }
    }
    case 'wait': {
      const ms = Math.max(0, Math.min(10_000, int(action.ms) ?? 150))
      return { ok: true, waitMs: ms }
    }
    default:
      return { ok: false, error: `未知动作类型 ${type}` }
  }
}

/**
 * 顺序执行一批动作；`wait` 在本地 sleep，其余下发采集器。
 * @param capture - ScreenCapture 实例。
 * @param actions - 动作数组。
 */
export async function applyActions (capture, actions) {
  const results = []
  for (const action of actions) {
    const result = applyAction(capture, action)
    if (result.waitMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, result.waitMs))
      results.push({ ok: true, type: 'wait' })
      continue
    }
    results.push({ ok: result.ok, ...(result.error ? { error: result.error } : {}) })
  }
  return results
}
