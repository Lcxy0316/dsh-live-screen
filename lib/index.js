/**
 * Live Screen 宿主半边。
 *
 * 注册三样东西：
 * - `live_screen` 工具：截图（图片进对话）+ 结构化动作（鼠标/键盘/窗口/程序）；
 * - `/live-screen/...` HTTP 路由：状态、快照、动作；
 * - `/live-screen/ws` 升级路由：同源 WebSocket，下行 JPEG 帧、上行控制指令。
 *
 * 采集本身由 native/ScreenHub.exe 完成（GDI DIBSection + JPEG），
 * 它在第一次需要画面时惰性启动，空闲 30 秒后自动退出，常驻内存约 40MB。
 * @module dsh-live-screen
 */

import { existsSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  EXE_PATH,
  SRC_PATH,
  ScreenCapture,
  buildCapture,
  captureAvailable
} from './capture.js'
import { applyAction, applyActions } from './actions.js'
import { upgradeToWebSocket } from './ws.js'

/** Loader 身份。 */
export const name = 'live-screen'

/** tools 是硬依赖；attachments 用于把截图塞进对话；webServer 惰性挂载。 */
export const inject = ['tools', 'attachments']

/** 本插件独占的路由前缀。 */
export const ROUTE_PREFIX = '/live-screen'

/** WebSocket 升级路径（同为宿主 origin，不受混合内容限制）。 */
export const WS_PATH = `${ROUTE_PREFIX}/ws`

/** 默认参数：1080p 下 12fps / q55 约 10Mbps，单帧 ~110KB。 */
const DEFAULTS = {
  fps: 12,
  scale: 1,
  quality: 55,
  idleMs: 30_000
}

const ATTACHMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' }
  }
}

function sendJson (res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  res.end(body)
}

async function readJsonBody (req, limit = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

/** 一次运行期内的共享状态：采集器 + 订阅者 + 最近一帧。 */
class LiveScreenRuntime {
  constructor (options) {
    this.options = { ...DEFAULTS, ...options }
    this.capture = new ScreenCapture({
      fps: this.options.fps,
      scale: this.options.scale,
      quality: this.options.quality
    })
    this.clients = new Set()
    this.latest = null
    this.latestAt = 0
    this.dropped = 0
    this.idleTimer = null
    this.restartTimer = null
    this.compiling = null
    this.lastError = null
    this.ready = Promise.resolve()

    this.capture.on('frame', (jpeg, at) => {
      this.latest = jpeg
      this.latestAt = at
      for (const client of this.clients) {
        if (!client.sendBinary(jpeg)) this.dropped++
      }
    })
    this.capture.on('error', () => {})
    this.capture.on('exit', (info) => {
      if (info.stopping) return
      // 采集器异常退出后重启一次；连续崩溃则由下一次取帧触发。
      if (this.clients.size === 0 && !this._wanted()) return
      clearTimeout(this.restartTimer)
      this.restartTimer = setTimeout(() => {
        this.ensure().catch(() => {})
      }, 1500)
    })
  }

  /** 有没有人正需要画面（WS 订阅者或最近一次取帧在 idle 窗口内）。 */
  _wanted () {
    if (this.clients.size > 0) return true
    return this.latestAt > 0 && Date.now() - this.latestAt < this.options.idleMs
  }

  /**
   * 确保采集器在跑，必要时先编译再启动。
   * fail-open：任何失败都只记在 lastError 里并返回 false，绝不把异常冒到宿主
   * bootstrap（否则一次 csc 失败会把整个 Harness 打死）。
   * @returns {Promise<boolean>} 采集器是否真的在跑。
   */
  async ensure () {
    if (this.capture.running) return true
    if (!captureAvailable()) {
      // 同一时刻只允许一次编译；并发调用共享同一个 promise。
      this.compiling ??= (async () => {
        try {
          await buildCapture()
          this.capture.start()
          this.lastError = null
          return true
        } catch (error) {
          this.lastError = error?.message ?? String(error)
          return false
        }
      })().finally(() => { this.compiling = null })
      return await this.compiling
    }
    try {
      this.capture.start()
      this.lastError = null
      return true
    } catch (error) {
      this.lastError = error?.message ?? String(error)
      return false
    }
  }

  /** 等采集器给出第一帧；超时返回 null。 */
  async firstFrame (timeoutMs = 6000) {
    if (this.latest && Date.now() - this.latestAt < 1000) return this.latest
    // 编不出来或起不来就立刻返回，不要白等一个超时。
    if (!await this.ensure() && !this.capture.running) return null
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.capture.off('frame', onFrame)
        resolve(null)
      }, timeoutMs)
      const onFrame = (jpeg) => {
        clearTimeout(timer)
        this.capture.off('frame', onFrame)
        resolve(jpeg)
      }
      this.capture.on('frame', onFrame)
    })
  }

  /** 抓一帧新鲜画面（最多等 timeoutMs）。 */
  async grab (timeoutMs = 6000) {
    this.latest = null
    this.latestAt = 0
    return await this.firstFrame(timeoutMs)
  }

  touch () {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.clients.size === 0) this.capture.stop()
    }, this.options.idleMs)
  }

  stats () {
    const capture = this.capture.stats
    const memory = process.memoryUsage()
    return {
      capture,
      clients: this.clients.size,
      droppedFrames: this.dropped,
      lastFrameAgeMs: this.latestAt ? Date.now() - this.latestAt : null,
      lastError: this.lastError,
      server: {
        rssMB: Number((memory.rss / 1048576).toFixed(1)),
        heapMB: Number((memory.heapUsed / 1048576).toFixed(1))
      }
    }
  }

  dispose () {
    clearTimeout(this.idleTimer)
    clearTimeout(this.restartTimer)
    for (const client of this.clients) {
      try { client.close(1001, 'plugin disposed') } catch {}
    }
    this.clients.clear()
    this.capture.stop()
  }
}

/** 把运行期状态挂到 ctx 上，reload 时复用同一个采集器。 */
const runtimes = new WeakMap()

function runtimeOf (ctx, options) {
  const existing = runtimes.get(ctx)
  if (existing) return existing
  const runtime = new LiveScreenRuntime(options)
  runtimes.set(ctx, runtime)
  return runtime
}

/** 挂 HTTP 路由与 WS 升级路由。 */
function registerRoutes (ctx, runtime) {
  ctx.inject(['webServer'], (routeCtx) => {
    const webserver = routeCtx.get('webServer')
    if (typeof webserver?.register !== 'function') return

    const handlers = {
      stats: async (_req, res) => sendJson(res, 200, { ok: true, ...runtime.stats() }),
      screen: async (_req, res) => {
        await runtime.ensure()
        const stats = runtime.capture.stats
        sendJson(res, 200, {
          ok: true,
          ready: stats.ready,
          width: stats.width,
          height: stats.height,
          srcWidth: stats.srcWidth,
          srcHeight: stats.srcHeight,
          error: runtime.lastError,
          note: '动作坐标使用 srcWidth×srcHeight 的原生像素，不是缩放后的流尺寸'
        })
      },
      snapshot: async (_req, res) => {
        const jpeg = await runtime.firstFrame()
        if (!jpeg) {
          const error = runtime.lastError
            ? `采集器不可用：${runtime.lastError}`
            : '采集器暂无画面（检查是否存在交互式桌面 SESSIONNAME=Console）'
          sendJson(res, 503, { ok: false, error })
          return
        }
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'content-length': jpeg.length,
          'cache-control': 'no-store'
        })
        res.end(jpeg)
      },
      action: async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '只接受 POST' }); return }
        let payload
        try {
          payload = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error.message ?? error) })
          return
        }
        await runtime.ensure()
        runtime.touch()
        const list = Array.isArray(payload) ? payload : [payload]
        const results = await applyActions(runtime.capture, list)
        sendJson(res, 200, { ok: results.every((r) => r.ok), results })
      },
      build: async (_req, res) => {
        try {
          const exe = await buildCapture()
          sendJson(res, 200, { ok: true, exe })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error.message ?? error) })
        }
      }
    }

    routeCtx.effect(() => {
      const disposeHttp = webserver.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const pathname = new URL(req.url ?? '/', 'http://x').pathname
          const key = pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
          const handler = handlers[key]
          if (handler === undefined) {
            sendJson(res, 404, { ok: false, error: `未知接口 ${pathname}` })
            return
          }
          try {
            await handler(req, res)
          } catch (error) {
            if (!res.headersSent) {
              sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            } else {
              res.end()
            }
          }
        }
      })
      return () => disposeHttp()
    }, 'live-screen: http routes')

    if (typeof webserver.registerUpgrade !== 'function') return

    routeCtx.effect(() => {
      const disposeUpgrade = webserver.registerUpgrade({
        path: WS_PATH,
        handler: (req, socket, head) => {
          const conn = upgradeToWebSocket(req, socket, head)
          if (!conn) return
          runtime.clients.add(conn)
          runtime.touch()

          // 先把采集器拉起来再发 hello，客户端才能一次拿到真实的原生尺寸。
          const announce = async () => {
            await runtime.ensure()
            const stats = runtime.capture.stats
            conn.sendText(JSON.stringify({
              type: 'hello',
              width: stats.width,
              height: stats.height,
              srcWidth: stats.srcWidth,
              srcHeight: stats.srcHeight,
              fps: stats.targetFps,
              quality: stats.quality
            }))
            if (runtime.latest) conn.sendBinary(runtime.latest)
          }
          announce()

          conn.on('message', (data, isBinary) => {
            if (isBinary) return
            let message
            try { message = JSON.parse(data) } catch { return }
            runtime.touch()
            if (message.type === 'ping') { conn.sendText(JSON.stringify({ type: 'pong' })); return }
            const list = message.type === 'batch'
              ? (Array.isArray(message.actions) ? message.actions : [])
              : [message.action ?? message]
            // 逐个执行并回 result，面板与脚本靠它确认动作真的落地。
            ;(async () => {
              const results = []
              for (const action of list) results.push(await applyAction(runtime.capture, action))
              conn.sendText(JSON.stringify({
                type: 'result',
                result: list.length === 1 ? results[0] : { ok: results.every((r) => r.ok), results }
              }))
            })()
          })
          conn.on('close', () => {
            runtime.clients.delete(conn)
            runtime.touch()
          })
        }
      })
      return () => disposeUpgrade()
    }, 'live-screen: ws route')
  })
}

/** 注册 `live_screen` 工具。 */
function registerTools (ctx, runtime) {
  ctx.tools.register(defineTool({
    name: 'live_screen',
    description:
      'See and drive the local Windows desktop the way a person would. Every call takes an `action`: "snapshot" returns the current screen as an image you can look at; "action" sends mouse/keyboard/window/program commands (move, click, scroll, type, key, focus, run) at native-pixel coordinates; "stats" reports capture health and memory. Use snapshot before and after acting so each step is grounded in what the screen actually shows.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'snapshot = 看当前屏幕；action = 执行动作；stats = 采集健康与内存；build = 编译原生采集器。'
      },
      steps: {
        type: 'array',
        description: '当 action=action 时按顺序执行的动作数组，元素形如 {"type":"click","x":400,"y":300}。',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            type: { type: 'string', required: true },
            x: { type: 'integer' },
            y: { type: 'integer' },
            button: { type: 'string' },
            count: { type: 'integer' },
            dy: { type: 'integer' },
            text: { type: 'string' },
            vk: { type: 'integer' },
            down: { type: 'boolean' },
            title: { type: 'string' },
            cmd: { type: 'string' },
            quality: { type: 'integer' },
            ms: { type: 'integer' }
          }
        }
      },
      saveTo: {
        type: 'string',
        description: '可选：把快照另存到会话工作区的相对路径，便于后续比对。'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          width: { type: 'integer' },
          height: { type: 'integer' },
          srcWidth: { type: 'integer' },
          srcHeight: { type: 'integer' },
          fps: { type: 'number' },
          bytes: { type: 'integer' },
          savedPath: { type: 'string' },
          message: { type: 'string' },
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          stats: { type: 'object', additionalProperties: true },
          attachments: { type: 'array', items: ATTACHMENT_SCHEMA }
        }
      },
      render: (_args, value) => {
        const head = value.ok
          ? `${value.action} 完成`
          : `${value.action} 失败：${value.message ?? '未知原因'}`
        const detail = []
        if (value.width && value.height) detail.push(`流 ${value.width}×${value.height}`)
        if (value.srcWidth && value.srcHeight) detail.push(`原生 ${value.srcWidth}×${value.srcHeight}`)
        if (value.fps) detail.push(`${value.fps}fps`)
        if (value.bytes) detail.push(`${(value.bytes / 1024).toFixed(0)}KB`)
        if (value.savedPath) detail.push(value.savedPath)
        const lines = [detail.length ? `${head}（${detail.join('，')}）` : head]
        if (Array.isArray(value.results) && value.results.length) {
          lines.push(...value.results.map((r, index) => `- #${index + 1} ${r.ok ? 'ok' : `失败 ${r.error ?? ''}`}`))
        }
        return [
          { type: 'text', text: lines.join('\n') },
          ...(value.attachments ?? []).map((attachment) => ({ type: 'image', attachment }))
        ]
      }
    },
    async execute (args) {
      const action = String(args.action ?? 'snapshot')
      if (action === 'stats') {
        return { ok: true, action, stats: runtime.stats() }
      }
      if (action === 'build') {
        try {
          const exe = await buildCapture()
          return { ok: true, action, message: `编译完成 ${exe}` }
        } catch (error) {
          return { ok: false, action, message: String(error?.message ?? error) }
        }
      }
      if (action === 'action') {
        const list = Array.isArray(args.steps) ? args.steps : []
        if (list.length === 0) return { ok: false, action, message: 'steps 不能为空' }
        await runtime.ensure()
        runtime.touch()
        const results = await applyActions(runtime.capture, list)
        const stats = runtime.capture.stats
        return {
          ok: results.every((r) => r.ok),
          action,
          width: stats.width,
          height: stats.height,
          srcWidth: stats.srcWidth,
          srcHeight: stats.srcHeight,
          results
        }
      }
      if (action !== 'snapshot') {
        return { ok: false, action, message: `不认识的 action: ${action}` }
      }
      const jpeg = await runtime.grab()
      if (!jpeg) {
        const visible = captureAvailable()
        return {
          ok: false,
          action,
          message: visible
            ? (runtime.lastError ?? '采集器启动了但没有出帧，检查是否在交互式桌面会话（SESSIONNAME=Console）')
            : `采集器未编译（${runtime.lastError ?? '未知原因'}），先调用 action=build（源码 ${SRC_PATH}，产物 ${EXE_PATH}）`
        }
      }
      const stats = runtime.capture.stats
      const attachment = await ctx.attachments.saveImage({
        data: jpeg,
        mediaType: 'image/jpeg',
        name: `live-screen-${Date.now()}.jpg`
      })
      return {
        ok: true,
        action,
        width: stats.width,
        height: stats.height,
        srcWidth: stats.srcWidth,
        srcHeight: stats.srcHeight,
        fps: stats.fps,
        bytes: jpeg.length,
        attachments: attachment ? [attachment] : []
      }
    }
  }))
}

/**
 * 插件入口。
 * @param ctx - Cordis 插件上下文。
 * @param config - 来自 profile 的配置（可选）。
 */
export function apply (ctx, config = {}) {
  const runtime = runtimeOf(ctx, {
    fps: config.fps ?? DEFAULTS.fps,
    scale: config.scale ?? DEFAULTS.scale,
    quality: config.quality ?? DEFAULTS.quality,
    idleMs: config.idleMs ?? DEFAULTS.idleMs
  })

  registerTools(ctx, runtime)
  registerRoutes(ctx, runtime)

  // 插件卸载时释放采集器；reload 时 runtime 复用，不会重启进程。
  ctx.effect(() => () => {
    runtime.dispose()
    runtimes.delete(ctx)
  }, 'live-screen: capture lifecycle')
}

export { ScreenCapture, applyAction, applyActions, buildCapture, captureAvailable, EXE_PATH, SRC_PATH }

export function isAvailable () {
  return existsSync(SRC_PATH)
}
