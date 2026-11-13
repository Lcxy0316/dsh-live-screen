window.__ModuleLoader__.load({
  id: 'dsh-live-screen',
  factory(require) {
    const React = require('react')

    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** 侧边栏面板 id，同时是 main 视图的 key。 */
    const PANEL_ID = 'live-screen'
    const NS = 'live-screen'
    const WS_PATH = '/live-screen/ws'
    /** 问宿主本机监听口的接口。相对 baseURI 解析：dsh-app://app/ 与带部署前缀的 http 都成立。 */
    const ENDPOINT_PATH = 'live-screen/endpoint'
    /** 建连接的上限：超时就把尝试过的地址写出来，不再无声地卡在「连接中」。 */
    const CONNECT_TIMEOUT_MS = 8000

    /** 工作台默认绑定的窗口标题片段；换窗口走 WS 的 open 消息。 */
    const DEFAULT_TARGET = ''

    const MESSAGES = {
      zh: {
        panel: '实时画面',
        title: '实时画面',
        subtitle: '独立工作台 · 单窗口采集',
        connect: '连接',
        disconnect: '断开',
        connecting: '连接中',
        offline: '未连接',
        live: '画面在流',
        empty: '等待第一帧…',
        noWindow: '还没绑定窗口',
        pickWindow: '选一个窗口',
        controlOn: '可以动手',
        controlOff: '只看不动',
        enableControl: '我要动手',
        disableControl: '放开控制',
        handback: '交还',
        holderAi: 'AI 在操作',
        holderUser: '你 / 别人在操作',
        holderNone: '无人操作',
        preempted: '你动了一下，控制权已还给你。停手几秒后 AI 才能接回。',
        typePlaceholder: '输入文字后回车，打到目标窗口',
        send: '发送',
        emptyText: '文字为空',
        fps: '帧率',
        mbps: '码率',
        latency: '延迟',
        frame: '画面',
        verified: '已回读',
        unverified: '画面没变',
        hint: '点画面即后台投递点击；只有需要「我要动手」时才会落到你的真实鼠标上。',
        errorPrefix: '出错：',
      },
      en: {
        panel: 'Live Screen',
        title: 'Live Screen',
        subtitle: 'Isolated workspace · single-window capture',
        connect: 'Connect',
        disconnect: 'Disconnect',
        connecting: 'Connecting',
        offline: 'Disconnected',
        live: 'Streaming',
        empty: 'Waiting for the first frame…',
        noWindow: 'No window bound',
        pickWindow: 'Pick a window',
        controlOn: 'Hands on',
        controlOff: 'View only',
        enableControl: 'Take control',
        disableControl: 'Release control',
        handback: 'Release',
        holderAi: 'AI is driving',
        holderUser: 'You (or someone) is driving',
        holderNone: 'Nobody driving',
        preempted: 'You touched it — control went back to you. Wait a moment before AI can take over.',
        typePlaceholder: 'Type text, press Enter to send it to the target window',
        send: 'Send',
        emptyText: 'Empty text',
        fps: 'FPS',
        mbps: 'Mbps',
        latency: 'Latency',
        frame: 'Frame',
        verified: 'Verified',
        unverified: 'No pixel change',
        hint: 'Clicks are posted to the window in the background; only "Hands on" touches your real mouse.',
        errorPrefix: 'Error: ',
      },
    }

    /** 常用按键的虚拟键码。 */
    const KEY_CODES = {
      Enter: 13,
      Escape: 27,
      Tab: 9,
      Backspace: 8,
      Delete: 46,
      ArrowUp: 38,
      ArrowDown: 40,
      ArrowLeft: 37,
      ArrowRight: 39,
      Home: 36,
      End: 35,
      PageUp: 33,
      PageDown: 34,
      ' ': 32,
    }

    function useStyles() {
      return {
        root: {
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          minHeight: 0,
          background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-primary)',
        },
        bar: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 12px',
          borderBottom: '1px solid var(--dsw-alias-border-l2)',
          flexWrap: 'wrap',
        },
        title: { fontSize: '13px', fontWeight: 600, letterSpacing: '0.01em' },
        subtitle: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
        spacer: { flex: 1 },
        pill: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          padding: '2px 8px',
          borderRadius: '999px',
          fontSize: '11px',
          border: '1px solid var(--dsw-alias-border-l2)',
          color: 'var(--dsw-alias-label-secondary)',
          background: 'var(--dsw-alias-bg-layer-1)',
          whiteSpace: 'nowrap',
        },
        dot: { width: '6px', height: '6px', borderRadius: '999px', background: 'var(--dsw-alias-state-idle-primary)' },
        button: {
          padding: '3px 10px',
          borderRadius: '6px',
          fontSize: '12px',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
          cursor: 'pointer',
        },
        buttonOn: {
          borderColor: 'var(--dsw-alias-brand-primary)',
          background: 'var(--dsw-alias-interactive-bg-active)',
        },
        stage: {
          position: 'relative',
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--dsw-alias-bg-layer-2)',
          overflow: 'hidden',
          outline: 'none',
        },
        canvas: {
          maxWidth: '100%',
          maxHeight: '100%',
          display: 'block',
          cursor: 'crosshair',
        },
        placeholder: {
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '12px',
          color: 'var(--dsw-alias-label-tertiary)',
          pointerEvents: 'none',
        },
        banner: {
          padding: '6px 12px',
          fontSize: '11px',
          color: 'var(--dsw-alias-state-warn-label)',
          background: 'var(--dsw-alias-state-warn-tertiary)',
          borderBottom: '1px solid var(--dsw-alias-border-l2)',
        },
        footer: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 12px',
          borderTop: '1px solid var(--dsw-alias-border-l2)',
        },
        input: {
          flex: 1,
          minWidth: 0,
          padding: '5px 9px',
          borderRadius: '6px',
          fontSize: '12px',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
          outline: 'none',
        },
        hint: { padding: '0 12px 8px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
        select: {
          padding: '3px 6px',
          borderRadius: '6px',
          fontSize: '12px',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
          maxWidth: '240px',
        },
      }
    }

    function PanelIcon({ size }) {
      const s = typeof size === 'number' ? size : 16
      return h(
        'svg',
        { width: s, height: s, viewBox: '0 0 16 16', 'aria-hidden': true, style: { display: 'block' } },
        h('rect', {
          x: 1.25, y: 2.25, width: 13.5, height: 10,
          rx: 1.6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
        }),
        h('path', { d: 'M6.5 5.4 L10.4 7.25 L6.5 9.1 Z', fill: 'currentColor' }),
        h('path', { d: 'M5.5 14.25 H10.5', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      )
    }

    /**
     * 主视图：同源 WebSocket 拉某个窗口的 JPEG 帧，canvas 绘制，交互反向下发。
     *
     * 与 v1 的差别：
     * - 画面是**一个窗口**，不是整屏，所以不会把自己镜像进去；
     * - 顶栏显示租约持有者（AI / 你 / 无人），被抢占时横幅告知；
     * - 每次动作的回报里带 `verified`，画面上没变化会明确标出来。
     */
    function LiveScreenView() {
      const styles = useMemo(() => useStyles(), [])
      const canvasRef = useRef(null)
      const stageRef = useRef(null)
      const socketRef = useRef(null)
      const bitmapRef = useRef(null)
      const controlRef = useRef(false)
      const reconnectRef = useRef(null)
      const meterRef = useRef({ at: 0, bytes: 0, intervals: 0, since: 0 })
      const statusTimerRef = useRef(null)
      const wantOpenRef = useRef(DEFAULT_TARGET)
      /** 记住工作台 id，重连时接回同一个，不要每次断线都新开一个宿主进程。 */
      const workspaceRef = useRef('')
      /** 宿主报告的本机监听口（`http://127.0.0.1:56020`），问一次就缓存。 */
      const baseRef = useRef('')
      /** 最近一次尝试连接的地址，超时/报错时直接摊给用户看。 */
      const attemptedRef = useRef('')
      const connectTimerRef = useRef(null)

      const [status, setStatus] = useState('offline')
      const [control, setControl] = useState(false)
      const [workspaceId, setWorkspaceId] = useState('')
      const [target, setTarget] = useState(null)
      const [lease, setLease] = useState({ holder: 'none', canAct: false })
      const [windows, setWindows] = useState([])
      const [metrics, setMetrics] = useState({ fps: 0, mbps: 0, latency: 0, width: 0, height: 0 })
      const [hasFrame, setHasFrame] = useState(false)
      const [draft, setDraft] = useState('')
      const [error, setError] = useState('')
      const [preempted, setPreempted] = useState(false)
      const [lastVerify, setLastVerify] = useState(null)

      controlRef.current = control

      const t = useCallback((key) => {
        const dict = MESSAGES[NS] ?? MESSAGES.zh
        return dict[key] ?? key
      }, [])

      /** 画面坐标 → 窗口内像素（PrintWindow 抓的是整窗，天然就是图像坐标）。 */
      const toSource = useCallback((event) => {
        const canvas = canvasRef.current
        if (!canvas) return null
        const rect = canvas.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return null
        const sx = (event.clientX - rect.left) / rect.width * canvas.width
        const sy = (event.clientY - rect.top) / rect.height * canvas.height
        return {
          x: Math.round(sx),
          y: Math.round(sy),
          localX: event.clientX - rect.left,
          localY: event.clientY - rect.top,
        }
      }, [])

      const send = useCallback((payload) => {
        const socket = socketRef.current
        if (!socket || socket.readyState !== 1) return false
        try {
          socket.send(JSON.stringify(payload))
          return true
        } catch {
          return false
        }
      }, [])

      const sendAction = useCallback((action) => send({ type: 'act', action }), [send])

      /* ---------------- 连接 ---------------- */
      /**
       * 本机监听口。
       *
       * Desktop 把页面挂在 `dsh-app://app/` 下，`location.host` 是单标签的 `app`，
       * 直接拿它拼 WebSocket 会得到 `ws://app/...`，永远连不上（表现为一直「连接中」）。
       * 所以先问宿主 `/live-screen/endpoint`；只有它答不上来时，才退回页面自己的 origin。
       */
      const resolveBase = useCallback(async () => {
        if (baseRef.current) return baseRef.current
        try {
          const response = await fetch(ENDPOINT_PATH, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (response.ok) {
            const value = await response.json()
            if (value && value.ok === true && typeof value.origin === 'string' && value.origin) {
              baseRef.current = value.origin
              return value.origin
            }
          }
        } catch {
          /* 宿主还没起或无这条路由，走下面的回退 */
        }
        const { protocol, host } = window.location
        if ((protocol === 'http:' || protocol === 'https:') && host) {
          baseRef.current = `${protocol}//${host}`
          return baseRef.current
        }
        return ''
      }, [])

      const connect = useCallback(() => {
        const existing = socketRef.current
        if (existing && (existing.readyState === 0 || existing.readyState === 1)) return
        setStatus('connecting')
        setError('')
        let cancelled = false

        ;(async () => {
          const base = await resolveBase()
          if (cancelled) return
          if (!base) {
            setStatus('offline')
            setError(`${t('errorPrefix')}no-endpoint`)
            return
          }
          const scheme = base.startsWith('https:') ? 'wss:' : 'ws:'
          const authority = base.replace(/^https?:\/\//, '')
          // 已存在的工作台就接回去（断线重连不该换一个宿主进程，也不该丢掉绑定的窗口）；
          // 没有才新建，带上要绑定的窗口选择器。
          const params = new URLSearchParams()
          if (workspaceRef.current) {
            params.set('id', workspaceRef.current)
          } else {
            params.set('fresh', '1')
            if (wantOpenRef.current) params.set('window', wantOpenRef.current)
          }
          const url = `${scheme}//${authority}${WS_PATH}?${params.toString()}`
          let socket
          try {
            socket = new WebSocket(url)
          } catch (e) {
            setStatus('offline')
            setError(String(e && e.message ? e.message : e))
            return
          }
          socket.binaryType = 'arraybuffer'
          socketRef.current = socket
          attemptedRef.current = url
          clearTimeout(connectTimerRef.current)
          connectTimerRef.current = setTimeout(() => {
            const current = socketRef.current
            if (current !== socket) return
            if (current.readyState === 0) {
              try { current.close() } catch {}
              socketRef.current = null
              setStatus('offline')
              setError(`${t('errorPrefix')}connect-timeout ${url}`)
            }
          }, CONNECT_TIMEOUT_MS)

          socket.onopen = () => {
            clearTimeout(connectTimerRef.current)
            setMetrics((prev) => ({ ...prev, fps: 0, mbps: 0 }))
            setError('')
            setStatus('live')
          }

          socket.onmessage = (event) => {
            if (typeof event.data !== 'string') {
              const buffer = event.data instanceof ArrayBuffer
                ? new Uint8Array(event.data)
                : new Uint8Array(event.data.buffer ?? event.data)
              const receivedAt = performance.now()
              const meter = meterRef.current
              meter.bytes += buffer.byteLength
              meter.intervals += 1
              if (!meter.since) meter.since = receivedAt
              if (receivedAt - meter.since >= 1000) {
                const elapsed = (receivedAt - meter.since) / 1000
                setMetrics((prev) => ({
                  ...prev,
                  fps: Number((meter.intervals / elapsed).toFixed(1)),
                  mbps: Number(((meter.bytes * 8) / elapsed / 1e6).toFixed(2)),
                }))
                meter.since = receivedAt
                meter.bytes = 0
                meter.intervals = 0
              }
              const canvas = canvasRef.current
              if (!canvas || typeof createImageBitmap !== 'function') return
              createImageBitmap(new Blob([buffer], { type: 'image/jpeg' })).then((bitmap) => {
                const previous = bitmapRef.current
                bitmapRef.current = bitmap
                if (previous && previous.close) previous.close()
                const ctx2d = canvas.getContext('2d')
                if (!ctx2d) { bitmap.close(); return }
                if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                  canvas.width = bitmap.width
                  canvas.height = bitmap.height
                }
                ctx2d.drawImage(bitmap, 0, 0)
                setHasFrame(true)
                setMetrics((prev) => ({
                  ...prev,
                  latency: Math.round(performance.now() - receivedAt),
                  width: bitmap.width,
                  height: bitmap.height,
                }))
              }).catch(() => {})
              return
            }

            let message
            try { message = JSON.parse(event.data) } catch { return }
            switch (message.type) {
              case 'hello':
                workspaceRef.current = message.workspaceId ?? ''
                setWorkspaceId(message.workspaceId ?? '')
                setTarget(message.target ?? null)
                if (message.lease) setLease(message.lease)
                // 首帧之后顺手拉一次窗口清单，供顶栏选择器用。
                send({ type: 'windows' })
                break
              case 'lease':
                setLease({ holder: message.holder, canAct: message.canAct === true })
                break
              case 'preempted':
                if (message.lease) setLease(message.lease)
                setPreempted(true)
                setControl(false)
                break
              case 'opened':
                if (message.ok) {
                  setTarget({ hwnd: message.hwnd, title: message.title, width: message.width, height: message.height })
                  setHasFrame(false)
                } else {
                  setError(`${t('errorPrefix')}${message.error ?? 'open-failed'}`)
                }
                break
              case 'windows':
                setWindows(Array.isArray(message.windows) ? message.windows : [])
                break
              case 'result': {
                const result = message.result ?? {}
                if (result.verified !== undefined) setLastVerify(result)
                if (result.ok === false && result.error) setError(`${t('errorPrefix')}${result.error}`)
                else if (result.ok !== false) setError('')
                break
              }
              case 'status':
                if (message.lease) setLease(message.lease)
                break
              case 'error':
                setError(`${t('errorPrefix')}${message.error ?? 'unknown'}`)
                break
              default:
                break
            }
          }

          socket.onerror = () => setError(`${t('errorPrefix')}websocket-error ${attemptedRef.current}`)
          socket.onclose = () => {
            clearTimeout(connectTimerRef.current)
            socketRef.current = null
            setStatus('offline')
            clearTimeout(reconnectRef.current)
            reconnectRef.current = setTimeout(() => { connect() }, 2500)
          }
        })()
      }, [resolveBase, send, t])

      const disconnect = useCallback(() => {
        clearTimeout(reconnectRef.current)
        clearTimeout(connectTimerRef.current)
        const socket = socketRef.current
        socketRef.current = null
        if (socket) { try { socket.close(1000, 'user') } catch {} }
        setStatus('offline')
      }, [])

      useEffect(() => {
        connect()
        statusTimerRef.current = setInterval(() => { send({ type: 'status' }) }, 3000)
        return () => {
          clearTimeout(reconnectRef.current)
          clearInterval(statusTimerRef.current)
          const socket = socketRef.current
          socketRef.current = null
          if (socket) { try { socket.close(1000, 'unmount') } catch {} }
          const bitmap = bitmapRef.current
          if (bitmap && bitmap.close) bitmap.close()
          bitmapRef.current = null
        }
      }, [connect, send])

      /* 用户主动开启控制 → 立刻向工作台申请租约；关掉就交还。 */
      useEffect(() => {
        if (status !== 'live') return
        send({ type: control ? 'lease-acquire' : 'lease-release' })
        if (control) setPreempted(false)
      }, [control, send, status])

      /* ---------------- 鼠标 ---------------- */
      const onClick = useCallback((event) => {
        const point = toSource(event)
        if (!point) return
        const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left'
        sendAction({ type: 'click', x: point.x, y: point.y, button })
      }, [sendAction, toSource])

      const onContextMenu = useCallback((event) => { event.preventDefault() }, [])

      const onPointerMove = useCallback((event) => {
        if (!controlRef.current) return
        const point = toSource(event)
        if (!point) return
        sendAction({ type: 'move', x: point.x, y: point.y })
      }, [sendAction, toSource])

      /* 滚轮必须原生非 passive 监听，React 的 onWheel 无法阻止页面滚动。 */
      useEffect(() => {
        const stage = stageRef.current
        if (!stage) return undefined
        const onWheel = (event) => {
          event.preventDefault()
          if (!controlRef.current) return
          const dy = Math.max(-1200, Math.min(1200, -event.deltaY))
          sendAction({ type: 'scroll', dy: Math.round(dy) })
        }
        stage.addEventListener('wheel', onWheel, { passive: false })
        return () => stage.removeEventListener('wheel', onWheel)
      }, [sendAction])

      /* ---------------- 键盘 ---------------- */
      const onKeyDown = useCallback((event) => {
        if (!controlRef.current) return
        const vk = KEY_CODES[event.key]
        if (vk === undefined) return
        event.preventDefault()
        sendAction({ type: 'key', vk, down: true })
        sendAction({ type: 'key', vk, down: false })
      }, [sendAction])

      const submitText = useCallback(() => {
        if (!draft) { setError(t('emptyText')); return }
        if (!controlRef.current) return
        sendAction({ type: 'type', text: draft })
        setDraft('')
      }, [draft, sendAction, t])

      const pickWindow = useCallback((hwnd) => {
        if (!hwnd) return
        setHasFrame(false)
        send({ type: 'open', hwnd })
      }, [send])

      /* ---------------- 派生文案 ---------------- */
      const statusText = status === 'live'
        ? t('live')
        : status === 'connecting' ? t('connecting') : t('offline')
      const dotColor = status === 'live'
        ? 'var(--dsw-alias-state-success-primary)'
        : status === 'connecting' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-idle-primary)'

      const holder = lease?.holder ?? 'none'
      const holderText = holder === 'ai' ? t('holderAi') : holder === 'user' ? t('holderUser') : t('holderNone')
      const holderColor = holder === 'ai'
        ? 'var(--dsw-alias-brand-primary)'
        : holder === 'user' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-idle-primary)'

      return h('div', { style: styles.root },
        h('div', { style: styles.bar },
          h('span', { style: styles.title }, t('title')),
          h('span', { style: styles.subtitle }, target ? target.title || `0x${Number(target.hwnd).toString(16)}` : t('noWindow')),
          h('span', { style: styles.spacer }),
          h('span', { style: styles.pill },
            h('span', { style: { ...styles.dot, background: dotColor } }),
            statusText,
          ),
          h('span', { style: styles.pill },
            h('span', { style: { ...styles.dot, background: holderColor } }),
            holderText,
          ),
          metrics.width > 0 && h('span', { style: styles.pill }, `${t('frame')} ${metrics.width}×${metrics.height}`),
          target && h('button', {
            type: 'button',
            style: styles.button,
            onClick: () => { setPreempted(false); send({ type: 'lease-release' }) },
          }, t('handback')),
          h('button', {
            type: 'button',
            style: { ...styles.button, ...(control ? styles.buttonOn : null) },
            onClick: () => setControl((prev) => !prev),
          }, control ? t('controlOn') : t('controlOff')),
          h('button', {
            type: 'button',
            style: styles.button,
            onClick: () => { if (status === 'offline') connect(); else disconnect() },
          }, status === 'offline' ? t('connect') : t('disconnect')),
        ),

        preempted && h('div', { style: styles.banner }, t('preempted')),

        windows.length > 0 && !preempted && h('div', { style: { ...styles.bar, borderBottom: 'none', paddingBottom: 0 } },
          h('span', { style: styles.subtitle }, t('pickWindow')),
          h('select', {
            style: styles.select,
            value: '',
            onChange: (event) => pickWindow(event.target.value),
          },
            h('option', { value: '' }, '—'),
            ...windows.slice(0, 40).map((w) => h('option', { key: String(w.hwnd), value: String(w.hwnd) },
              `${w.title || '(无标题)'} · ${w.rect?.[2] ?? 0}×${w.rect?.[3] ?? 0}`)),
          ),
        ),

        h('div', {
          ref: stageRef,
          style: styles.stage,
          tabIndex: 0,
          onKeyDown,
        },
          h('canvas', {
            ref: canvasRef,
            style: styles.canvas,
            onClick,
            onPointerMove,
            onContextMenu,
          }),
          !hasFrame && h('div', { style: styles.placeholder },
            target ? t('empty') : t('noWindow')),
        ),

        h('div', { style: styles.footer },
          h('input', {
            style: styles.input,
            value: draft,
            placeholder: t('typePlaceholder'),
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') { event.preventDefault(); submitText() }
            },
          }),
          h('button', {
            type: 'button',
            style: styles.button,
            onClick: submitText,
            disabled: !control || draft.length === 0,
          }, t('send')),
          lastVerify && h('span', {
            style: { ...styles.pill, color: lastVerify.verified ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)' },
          }, lastVerify.verified ? t('verified') : t('unverified')),
        ),

        error
          ? h('div', { style: { ...styles.hint, color: 'var(--dsw-alias-label-error)' } }, error)
          : h('div', { style: styles.hint }, t('hint')),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, MESSAGES), 'live-screen: dictionaries')
        const t = ctx.locale.bind(NS)

        /* 侧边栏面板图标：点它就切到 main 里同 key 的视图。 */
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 60,
          label: () => t('panel'),
          locale: NS,
        }, PanelIcon))

        /* 主区视图：与面板图标同 id，由 layout 的 activePanelId 驱动。 */
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, LiveScreenView))
      },
    }
  },
})
