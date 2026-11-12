/**
 * Live Screen 宿主半边 —— v2「独立工作台」版。
 *
 * 与 v1 的根本差别：不再抓整屏抢物理鼠标，而是给每个目标窗口开一个工作台
 * （`Workspace` = 一个 DesktopHost 进程 + 一个窗口 + 一套控制权租约）。
 * AI 在窗口 A 里打字时，用户还能照常操作窗口 B。
 *
 * 对外三样东西：
 * - `live_screen` 工具：open / snapshot / act / lease / list / close / stats；
 * - `/live-screen/...` HTTP 路由：工作台生命周期、快照、动作、列表；
 * - `/live-screen/ws` 升级路由：同源 WebSocket，下行帧、上行动作、租约仲裁。
 *
 * 采集器是 native/DesktopHost.exe（PrintWindow + 分块哈希去重 + JPEG），
 * 首次需要时惰性编译，空闲超时自动关闭工作台。
 * @module dsh-live-screen
 */

import { existsSync } from 'node:fs'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { HOST_EXE, HOST_SRC, buildHost, hostAvailable } from './host.js'
import { ControlLease, HOLDER_AI, HOLDER_NONE, HOLDER_USER, ERR_PREEMPTED } from './lease.js'
import { Workspace, WORKSPACE_DEFAULTS } from './workspace.js'
import { upgradeToWebSocket } from './ws.js'

/** Loader 身份。 */
export const name = 'live-screen'

/** tools 是硬依赖；attachments 用于把截图塞进对话；webServer 惰性挂载。 */
export const inject = ['tools', 'attachments']

/** 本插件独占的路由前缀。 */
export const ROUTE_PREFIX = '/live-screen'

/** WebSocket 升级路径（同为宿主 origin，不受混合内容限制）。 */
export const WS_PATH = `${ROUTE_PREFIX}/ws`

const DEFAULTS = {
  fps: 20,
  quality: 70,
  idleMs: 60_000,
  leaseTtlMs: 2000
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

/** 工作台管理器：持有全部 Workspace，负责空闲回收与广播。 */
class WorkspaceManager {
  constructor (options) {
    this.options = { ...DEFAULTS, ...options }
    this.workspaces = new Map()
    this.clients = new Map() // Workspace -> Set<WsConnection>
    this.dropped = 0
    this.reaper = setInterval(() => this.#reap(), 5000)
    this.reaper.unref?.()
  }

  #reap () {
    const now = Date.now()
    for (const [id, ws] of this.workspaces) {
      const watchers = this.clients.get(ws)?.size ?? 0
      if (watchers > 0) continue
      if (now - ws.lastUsedAt < this.options.idleMs) continue
      ws.close().catch(() => {})
      this.workspaces.delete(id)
      this.clients.delete(ws)
    }
  }

  create (options = {}) {
    const ws = new Workspace({
      fps: options.fps ?? this.options.fps,
      quality: options.quality ?? this.options.quality,
      leaseTtlMs: options.leaseTtlMs ?? this.options.leaseTtlMs
    })
    const watchers = new Set()
    this.clients.set(ws, watchers)
    this.workspaces.set(ws.id, ws)

    ws.on('frame', (frame) => {
      for (const client of watchers) if (!client.sendBinary(frame.jpeg)) this.dropped += 1
    })
    ws.on('preempted', (info) => {
      for (const client of watchers) {
        try { client.sendText(JSON.stringify({ type: 'preempted', ...info, lease: ws.lease.snapshot() })) } catch {}
      }
    })
    ws.on('closed', () => {
      this.workspaces.delete(ws.id)
      this.clients.delete(ws)
    })
    return ws
  }

  get (id) {
    return this.workspaces.get(id) ?? null
  }

  /** 只有一个工作台时允许省略 id，省得模型每次都要记住编号。 */
  resolve (id) {
    if (id) return this.get(id)
    const list = [...this.workspaces.values()]
    return list.length === 1 ? list[0] : null
  }

  list () {
    return [...this.workspaces.values()].map((ws) => ws.status())
  }

  stats () {
    const memory = process.memoryUsage()
    return {
      workspaces: this.list(),
      watchers: [...this.clients.values()].reduce((sum, set) => sum + set.size, 0),
      droppedFrames: this.dropped,
      server: {
        rssMB: Number((memory.rss / 1048576).toFixed(1)),
        heapMB: Number((memory.heapUsed / 1048576).toFixed(1))
      },
      nativeHost: { available: hostAvailable(), exe: HOST_EXE, src: HOST_SRC }
    }
  }

  dispose () {
    clearInterval(this.reaper)
    for (const [, set] of this.clients) {
      for (const client of set) { try { client.close(1001, 'plugin disposed') } catch {} }
    }
    this.clients.clear()
    for (const ws of this.workspaces.values()) ws.close().catch(() => {})
    this.workspaces.clear()
  }
}

const managers = new WeakMap()

function managerOf (ctx, config) {
  const existing = managers.get(ctx)
  if (existing) return existing
  const manager = new WorkspaceManager({
    fps: config.fps ?? DEFAULTS.fps,
    quality: config.quality ?? DEFAULTS.quality,
    idleMs: config.idleMs ?? DEFAULTS.idleMs,
    leaseTtlMs: config.leaseTtlMs ?? DEFAULTS.leaseTtlMs
  })
  managers.set(ctx, manager)
  return manager
}

/** 挂 HTTP 路由与 WS 升级路由。 */
function registerRoutes (ctx, manager) {
  ctx.inject(['webServer'], (routeCtx) => {
    const webserver = routeCtx.get('webServer')
    if (typeof webserver?.register !== 'function') return

    const handlers = {
      stats: async (_req, res) => sendJson(res, 200, { ok: true, ...manager.stats() }),

      windows: async (_req, res) => {
        // 已经有工作台就借它的宿主列窗口，别为了看一眼列表就再起一个进程。
        const existing = [...manager.workspaces.values()].find((ws) => ws.host?.running) ??
          [...manager.workspaces.values()][0]
        if (existing) {
          const windows = await existing.listWindows().catch(() => [])
          sendJson(res, 200, { ok: true, windows, reused: existing.id })
          return
        }
        const scratch = manager.create({ fps: 1, quality: 30 })
        try {
          const windows = await scratch.listWindows()
          sendJson(res, 200, { ok: true, windows })
        } finally {
          await scratch.close()
          manager.workspaces.delete(scratch.id)
        }
      },

      workspaces: async (req, res) => {
        if (req.method === 'POST') {
          let payload = {}
          try { payload = await readJsonBody(req) } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error.message ?? error) })
            return
          }
          const ws = manager.create(payload)
          let opened = null
          if (payload.window !== undefined && payload.window !== null) {
            opened = await ws.open(payload.window)
            if (!opened.ok) {
              await ws.close()
              manager.workspaces.delete(ws.id)
              sendJson(res, 400, { ok: false, error: opened.error, detail: opened })
              return
            }
            ws.startProbe()
          }
          sendJson(res, 200, { ok: true, id: ws.id, target: ws.target, opened })
          return
        }
        sendJson(res, 200, { ok: true, workspaces: manager.list() })
      },

      list: async (req, res) => {
        // GET /live-screen/list → 可绑定窗口；DELETE /live-screen/list/<id> → 关工作台
        const url = new URL(req.url ?? '/', 'http://x')
        const id = url.pathname.slice(`${ROUTE_PREFIX}/list`.length).replace(/^\/+/, '')
        if (req.method === 'DELETE') {
          const ws = manager.get(id)
          if (!ws) { sendJson(res, 404, { ok: false, error: '工作台不存在' }); return }
          await ws.close()
          manager.workspaces.delete(id)
          sendJson(res, 200, { ok: true, closed: id })
          return
        }
        const existing = [...manager.workspaces.values()].find((w) => w.host?.running) ??
          [...manager.workspaces.values()][0]
        if (existing) {
          const windows = await existing.listWindows().catch(() => [])
          sendJson(res, 200, { ok: true, windows, reused: existing.id })
          return
        }
        const scratch = manager.create({ fps: 1, quality: 30 })
        try {
          const windows = await scratch.listWindows()
          sendJson(res, 200, { ok: true, windows })
        } finally {
          await scratch.close()
          manager.workspaces.delete(scratch.id)
        }
      },

      build: async (_req, res) => {
        try {
          const exe = await buildHost()
          sendJson(res, 200, { ok: true, exe })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error.message ?? error) })
        }
      }
    }

    // /live-screen/ws/<id>/... 这类带 id 的路径单独走前缀分发
    const scoped = async (req, res, rest) => {
      const [id, ...tailParts] = rest.split('/').filter(Boolean)
      const tail = tailParts.join('/')
      const ws = manager.get(id)
      if (!ws) { sendJson(res, 404, { ok: false, error: `工作台 ${id} 不存在` }); return }

      if (tail === 'snapshot' || tail === '') {
        const frame = await ws.grab()
        if (!frame) { sendJson(res, 503, { ok: false, error: ws.lastError ?? '暂无画面' }); return }
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'content-length': frame.jpeg.length,
          'cache-control': 'no-store',
          'x-frame-seq': String(frame.seq)
        })
        res.end(frame.jpeg)
        return
      }
      if (tail === 'status') { sendJson(res, 200, { ok: true, ...ws.status() }); return }
      if (tail === 'lease') {
        if (req.method === 'DELETE') { sendJson(res, 200, { ok: true, ...ws.lease.release('http') }); return }
        sendJson(res, 200, { ok: true, ...ws.lease.acquire(HOLDER_AI) })
        return
      }
      if (tail === 'act') {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '只接受 POST' }); return }
        let payload
        try { payload = await readJsonBody(req) } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error.message ?? error) })
          return
        }
        // 三种载荷都认：裸动作 {type,...}、动作数组 [{...}]、包一层 {steps:[...]} / {actions:[...]}
        const list = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.steps)
            ? payload.steps
            : Array.isArray(payload?.actions)
              ? payload.actions
              : [payload]
        if (list.length === 0) { sendJson(res, 400, { ok: false, error: '动作列表为空' }); return }
        const opts = {
          force: payload?.force === true,
          degrade: payload?.degrade !== false
        }
        const result = list.length === 1 ? await ws.act(list[0], opts) : await ws.actAll(list, opts)
        sendJson(res, 200, result)
        return
      }
      if (tail === 'open') {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '只接受 POST' }); return }
        let payload = {}
        try { payload = await readJsonBody(req) } catch {}
        const opened = await ws.open(payload.window ?? payload.title ?? payload.hwnd)
        if (opened.ok) ws.startProbe()
        sendJson(res, opened.ok ? 200 : 400, opened)
        return
      }
      sendJson(res, 404, { ok: false, error: `未知接口 ${tail}` })
    }

    routeCtx.effect(() => {
      const disposeHttp = webserver.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const pathname = new URL(req.url ?? '/', 'http://x').pathname
          const rest = pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
          const [head] = rest.split('/')
          try {
            if (manager.workspaces.size > 0 && manager.get(head)) { await scoped(req, res, rest); return }
            const handler = handlers[rest] ?? handlers[head]
            if (handler === undefined) {
              if (manager.get(head)) { await scoped(req, res, rest); return }
              sendJson(res, 404, { ok: false, error: `未知接口 ${pathname}` })
              return
            }
            await handler(req, res)
          } catch (error) {
            if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            else res.end()
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

          // /live-screen/ws?id=<workspaceId>&window=<选择器>
          const url = new URL(req.url ?? '/', 'http://x')
          let ws = manager.get(url.searchParams.get('id') ?? '')
          const created = ws === null

          const ready = (async () => {
            if (!ws) {
              ws = manager.create({})
              if (url.searchParams.get('window')) {
                const opened = await ws.open(url.searchParams.get('window'))
                if (!opened.ok) {
                  conn.sendText(JSON.stringify({ type: 'error', error: opened.error, detail: opened }))
                  await ws.close()
                  manager.workspaces.delete(ws.id)
                  return
                }
              }
            }
            const watchers = manager.clients.get(ws)
            watchers?.add(conn)
            ws.startProbe()
            await ws.ensureHost().catch(() => {})
            const status = ws.status()
            conn.sendText(JSON.stringify({
              type: 'hello',
              workspaceId: ws.id,
              created,
              target: ws.target,
              host: status.host,
              lease: status.lease,
              fps: ws.options.fps,
              quality: ws.options.quality
            }))
            const frame = await ws.grab(4000).catch(() => null)
            if (frame) conn.sendBinary(frame.jpeg)
          })()

          conn.on('message', (data, isBinary) => {
            if (isBinary) return
            let message
            try { message = JSON.parse(data) } catch { return }
            ;(async () => {
              await ready
              const live = ws
              if (!live) { conn.sendText(JSON.stringify({ type: 'error', error: '工作台已关闭' })); return }
              live.touch()
              try {
                switch (message.type) {
                  case 'ping':
                    conn.sendText(JSON.stringify({ type: 'pong' }))
                    return
                  case 'lease-acquire':
                    conn.sendText(JSON.stringify({ type: 'lease', ...live.lease.acquire(HOLDER_AI) }))
                    return
                  case 'lease-release':
                    conn.sendText(JSON.stringify({ type: 'lease', ...live.lease.release('user') }))
                    return
                  case 'windows': {
                    const list = await live.listWindows().catch(() => [])
                    conn.sendText(JSON.stringify({ type: 'windows', windows: list }))
                    return
                  }
                  case 'open': {
                    const opened = await live.open(message.window ?? message.title ?? message.hwnd)
                    if (opened.ok) live.startProbe()
                    conn.sendText(JSON.stringify({ type: 'opened', ...opened }))
                    return
                  }
                  case 'act':
                  case 'batch': {
                    const list = message.type === 'batch'
                      ? (Array.isArray(message.actions) ? message.actions : [])
                      : [message.action ?? message]
                    const result = list.length === 1
                      ? await live.act(list[0], { force: message.force === true, degrade: message.degrade !== false })
                      : await live.actAll(list, { force: message.force === true, degrade: message.degrade !== false })
                    conn.sendText(JSON.stringify({ type: 'result', result }))
                    return
                  }
                  case 'status':
                    conn.sendText(JSON.stringify({ type: 'status', ...live.status() }))
                    return
                  default:
                    conn.sendText(JSON.stringify({ type: 'error', error: `未知消息 ${message.type}` }))
                }
              } catch (error) {
                conn.sendText(JSON.stringify({ type: 'error', error: String(error?.message ?? error) }))
              }
            })()
          })

          conn.on('close', () => {
            if (!ws) return
            manager.clients.get(ws)?.delete(conn)
            ws.touch()
            // 没人看且没有窗口绑定的临时工作台，立刻关掉，别留垃圾进程。
            if (!ws.target && (manager.clients.get(ws)?.size ?? 0) === 0) {
              ws.close().catch(() => {})
              manager.workspaces.delete(ws.id)
            }
          })
        }
      })
      return () => disposeUpgrade()
    }, 'live-screen: ws route')
  })
}

/** 注册 `live_screen` 工具。 */
function registerTools (ctx, manager) {
  ctx.tools.register(defineTool({
    name: 'live_screen',
    description:
      'Work inside an isolated window workspace on the local Windows desktop. '
      + 'Unlike full-screen capture, each workspace binds ONE target window: capture uses PrintWindow so the user keeps their own mouse, keyboard and foreground window. '
      + 'Every call takes an `action`. '
      + '"list" lists bindable windows; '
      + '"open" binds a window (by title fragment or hwnd) and returns the workspace id; '
      + '"snapshot" returns the current window image you can look at; '
      + '"act" executes steps (move/click/scroll/type/key/run/quality) in window-image coordinates, each action verified by re-reading pixels; '
      + '"lease" reads or takes the control lease -- when the user touches their real mouse the lease is preempted and actions fail with preempted-by-user; '
      + '"close" ends a workspace; "stats" reports health. '
      + 'Always snapshot before acting so coordinates match the window you actually bound.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'list = 列出可绑定窗口；open = 绑定窗口；snapshot = 看当前画面；act = 执行动作；lease = 查/取控制权；close = 关闭工作台；stats = 健康与内存；build = 编译原生宿主。'
      },
      workspace: {
        type: 'string',
        description: '工作台 id（只有一个时可省略）。'
      },
      window: {
        type: 'string',
        description: 'action=open 时的目标：窗口标题片段或 hwnd（如 "计算器" 或 "0x808d2"）。'
      },
      steps: {
        type: 'array',
        description: 'action=act 时的动作数组，坐标用窗口图像的像素。',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            type: { type: 'string', required: true },
            x: { type: 'integer' },
            y: { type: 'integer' },
            button: { type: 'string' },
            dy: { type: 'integer' },
            text: { type: 'string' },
            vk: { type: 'integer' },
            down: { type: 'boolean' },
            cmd: { type: 'string' },
            quality: { type: 'integer' },
            ms: { type: 'integer' }
          }
        }
      },
      force: {
        type: 'boolean',
        description: 'act 时强制走前台 SendInput（默认先试后台 PostMessage，失败自动降级）。文字输入默认就是 true，因为后台投递的文字没有任何窗口会接受；传 false 可强制只试后台。'
      },
      degrade: {
        type: 'boolean',
        description: 'act 时是否允许「L1 没改动画面就自动降级重试 L2」。默认 true；设为 false 则只试后台投递，绝不动你的光标。type 永不重试（UWP 会叠加排队的 WM_CHAR 导致重复输入）。'
      },
      saveTo: {
        type: 'string',
        description: '可选：把快照另存到会话工作区的相对路径。'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          message: { type: 'string' },
          workspace: { type: 'string' },
          target: { type: 'object', additionalProperties: true },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
          seq: { type: 'integer' },
          savedPath: { type: 'string' },
          windows: { type: 'array', items: { type: 'object', additionalProperties: true } },
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          lease: { type: 'object', additionalProperties: true },
          stats: { type: 'object', additionalProperties: true },
          attachments: { type: 'array', items: ATTACHMENT_SCHEMA }
        }
      },
      render: (_args, value) => {
        const head = value.ok
          ? `${value.action} 完成`
          : `${value.action} 失败：${value.message ?? '未知原因'}`
        const detail = []
        if (value.target?.title) detail.push(value.target.title)
        if (value.width && value.height) detail.push(`${value.width}×${value.height}`)
        if (value.bytes) detail.push(`${(value.bytes / 1024).toFixed(0)}KB`)
        if (value.lease?.holder) detail.push(`控制权=${value.lease.holder}`)
        const lines = [detail.length ? `${head}（${detail.join('，')}）` : head]
        if (Array.isArray(value.results) && value.results.length) {
          lines.push(...value.results.map((r, i) => {
            const mark = r.ok ? 'ok' : `失败 ${r.error ?? ''}`
            const verified = r.verified === undefined ? '' : r.verified ? ' · 已回读确认' : ' · 画面无变化'
            return `- #${i + 1} ${mark}${verified}`
          }))
        }
        if (Array.isArray(value.windows) && value.windows.length) {
          lines.push(...value.windows.slice(0, 15).map((w) => `- ${w.title || '(无标题)'} ${w.rect?.[2]}×${w.rect?.[3]} ${w.hwnd}`))
        }
        return [
          { type: 'text', text: lines.join('\n') },
          ...(value.attachments ?? []).map((attachment) => ({ type: 'image', attachment }))
        ]
      }
    },
    async execute (args, exec) {
      const action = String(args.action ?? 'snapshot')

      if (action === 'stats') return { ok: true, action, stats: manager.stats() }

      if (action === 'build') {
        try {
          const exe = await buildHost()
          return { ok: true, action, message: `编译完成 ${exe}` }
        } catch (error) {
          return { ok: false, action, message: String(error?.message ?? error) }
        }
      }

      if (action === 'list') {
        const probe = manager.create({ fps: 1, quality: 30 })
        try {
          const windows = await probe.listWindows()
          if (windows.length === 0) {
            return { ok: false, action, message: probe.lastError ?? '没有可绑定窗口（需要交互式桌面会话）' }
          }
          return { ok: true, action, windows }
        } finally {
          await probe.close()
        }
      }

      if (action === 'open') {
        const ws = manager.create({})
        const opened = await ws.open(args.window ?? '')
        if (!opened.ok) {
          await ws.close()
          manager.workspaces.delete(ws.id)
          return { ok: false, action, message: `绑定失败：${opened.error}`, windows: opened.candidates ?? [] }
        }
        ws.startProbe()
        return { ok: true, action, workspace: ws.id, target: ws.target, lease: ws.lease.snapshot() }
      }

      const ws = manager.resolve(args.workspace)
      if (!ws) {
        return { ok: false, action, message: args.workspace ? `工作台 ${args.workspace} 不存在` : '还没有工作台，先 action=open 绑定一个窗口' }
      }

      if (action === 'close') {
        const id = ws.id
        await ws.close()
        manager.workspaces.delete(id)
        return { ok: true, action, workspace: id, message: '已关闭' }
      }

      if (action === 'lease') {
        const took = ws.lease.acquire(HOLDER_AI)
        return { ok: took.ok, action, workspace: ws.id, lease: ws.lease.snapshot(), message: took.ok ? undefined : '用户正持有控制权' }
      }

      if (action === 'act') {
        const list = Array.isArray(args.steps) ? args.steps : []
        if (list.length === 0) return { ok: false, action, message: 'steps 不能为空' }
        const opts = { force: args.force === true, degrade: args.degrade !== false }
        const result = list.length === 1
          ? await ws.act(list[0], opts)
          : await ws.actAll(list, opts)
        const lease = ws.lease.snapshot()
        if (!result.ok && result.error === ERR_PREEMPTED) {
          return { ok: false, action, workspace: ws.id, lease, results: [result], message: '你正在操作电脑，动作已让给你；停手后再来，或先看一眼画面重新规划。' }
        }
        return { ok: result.ok, action, workspace: ws.id, lease, results: result.results ?? [result] }
      }

      if (action !== 'snapshot') {
        return { ok: false, action, message: `不认识的 action: ${action}` }
      }

      const frame = await ws.grab()
      if (!frame) return { ok: false, action, message: ws.lastError ?? '没有出帧' }

      let savedPath
      if (args.saveTo) {
        const cwd = exec?.agent?.session?.header?.cwd
        if (cwd) {
          const { writeFile, mkdir } = await import('node:fs/promises')
          const path = await import('node:path')
          const full = path.resolve(cwd, String(args.saveTo))
          await mkdir(path.dirname(full), { recursive: true })
          await writeFile(full, frame.jpeg)
          savedPath = String(args.saveTo)
        }
      }

      const attachment = await ctx.attachments.saveImage({
        data: frame.jpeg,
        mediaType: 'image/jpeg',
        name: `live-screen-${ws.id}-${frame.seq}.jpg`
      })
      return {
        ok: true,
        action,
        workspace: ws.id,
        target: ws.target,
        width: frame.width,
        height: frame.height,
        bytes: frame.jpeg.length,
        seq: frame.seq,
        lease: ws.lease.snapshot(),
        savedPath,
        attachments: attachment ? [attachment] : []
      }
    }
  }))
}

/**
 * 插件入口。
 * @param ctx - Cordis 插件上下文。
 * @param config - 来自 profile 的配置（fps / quality / idleMs / leaseTtlMs）。
 */
export function apply (ctx, config = {}) {
  const manager = managerOf(ctx, config)
  registerTools(ctx, manager)
  registerRoutes(ctx, manager)
  ctx.effect(() => () => {
    manager.dispose()
    managers.delete(ctx)
  }, 'live-screen: workspace lifecycle')
}

export { Workspace, WORKSPACE_DEFAULTS, ControlLease, HOLDER_AI, HOLDER_NONE, HOLDER_USER, buildHost, hostAvailable, HOST_EXE, HOST_SRC }

export function isAvailable () {
  return existsSync(HOST_SRC)
}
