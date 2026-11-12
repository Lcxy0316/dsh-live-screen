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

    const MESSAGES = {
      zh: {
        panel: '实时画面',
        title: '实时画面',
        subtitle: '本机桌面 · 同源推流',
        connect: '连接',
        disconnect: '断开',
        connecting: '连接中',
        offline: '未连接',
        controlOn: '控制开启',
        controlOff: '控制关闭',
        enableControl: '开启控制',
        disableControl: '关闭控制',
        typePlaceholder: '输入文字后回车，直接打到当前焦点窗口',
        send: '发送',
        quality: '画质',
        empty: '等待第一帧…',
        hint: '点击画面即注入鼠标事件；开启控制后键盘与文字才会下发。',
        fps: '帧率',
        mbps: '码率',
        latency: '延迟',
        size: '画面',
        source: '原生',
        idle: '空闲',
        live: '推流中',
        drop: '丢帧',
      },
      en: {
        panel: 'Live Screen',
        title: 'Live Screen',
        subtitle: 'Local desktop · same-origin stream',
        connect: 'Connect',
        disconnect: 'Disconnect',
        connecting: 'Connecting',
        offline: 'Disconnected',
        controlOn: 'Control on',
        controlOff: 'Control off',
        enableControl: 'Enable control',
        disableControl: 'Disable control',
        typePlaceholder: 'Type text, press Enter to send it to the focused window',
        send: 'Send',
        quality: 'Quality',
        empty: 'Waiting for the first frame…',
        hint: 'Clicks inject at once; keyboard and text need control enabled.',
        fps: 'FPS',
        mbps: 'Mbps',
        latency: 'Latency',
        size: 'Frame',
        source: 'Native',
        idle: 'Idle',
        live: 'Live',
        drop: 'Dropped',
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
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          padding: '4px 10px',
          fontSize: '11px',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
          cursor: 'pointer',
        },
        buttonOn: {
          borderColor: 'var(--dsw-alias-brand-primary)',
          color: 'var(--dsw-alias-brand-primary)',
          background: 'var(--dsw-alias-interactive-bg-active)',
        },
        stage: {
          position: 'relative',
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          background: 'var(--dsw-alias-bg-layer-2)',
          outline: 'none',
        },
        canvas: {
          maxWidth: '100%',
          maxHeight: '100%',
          display: 'block',
          cursor: 'crosshair',
          borderRadius: '4px',
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
        footer: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '8px 12px',
          borderTop: '1px solid var(--dsw-alias-border-l2)',
        },
        input: {
          flex: 1,
          minWidth: 0,
          padding: '5px 8px',
          fontSize: '12px',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
          outline: 'none',
        },
        hint: { padding: '0 12px 8px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
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
     * 主视图：同源 WebSocket 拉 JPEG 帧，canvas 绘制，交互反向下发。
     * 坐标换算统一走 canvas 的 bounding rect → 原生像素。
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

      const [status, setStatus] = useState('offline')
      const [control, setControl] = useState(false)
      const [meta, setMeta] = useState({ width: 0, height: 0, srcWidth: 0, srcHeight: 0 })
      const [metrics, setMetrics] = useState({ fps: 0, mbps: 0, latency: 0, dropped: 0 })
      const [hasFrame, setHasFrame] = useState(false)
      const [draft, setDraft] = useState('')
      const [error, setError] = useState('')

      controlRef.current = control

      const t = useCallback((key) => {
        const dict = MESSAGES[NS] ?? MESSAGES.zh
        return dict[key] ?? key
      }, [])

      /** 把 DOM 事件坐标换算成采集器使用的原生像素。 */
      const toSource = useCallback((event) => {
        const canvas = canvasRef.current
        if (!canvas) return null
        const rect = canvas.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return null
        const naturalWidth = canvas.width
        const naturalHeight = canvas.height
        const streamX = (event.clientX - rect.left) / rect.width * naturalWidth
        const streamY = (event.clientY - rect.top) / rect.height * naturalHeight
        const sx = meta.srcWidth || naturalWidth
        const sy = meta.srcHeight || naturalHeight
        return {
          x: Math.round(streamX / naturalWidth * sx),
          y: Math.round(streamY / naturalHeight * sy),
          localX: event.clientX - rect.left,
          localY: event.clientY - rect.top,
          rect,
        }
      }, [meta.srcWidth, meta.srcHeight])

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

      const sendAction = useCallback((action) => send({ type: 'action', action }), [send])

      /* ---------------- 连接 ---------------- */
      const connect = useCallback(() => {
        const existing = socketRef.current
        if (existing && (existing.readyState === 0 || existing.readyState === 1)) return
        setStatus('connecting')
        setError('')
        const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const url = `${scheme}//${window.location.host}${WS_PATH}`
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

        socket.onopen = () => {
          setStatus('live')
          setMetrics((prev) => ({ ...prev, dropped: 0 }))
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
              const fps = meter.intervals / elapsed
              const mbps = (meter.bytes * 8) / elapsed / 1e6
              meter.since = receivedAt
              meter.bytes = 0
              meter.intervals = 0
              setMetrics((prev) => ({
                fps: Number(fps.toFixed(1)),
                mbps: Number(mbps.toFixed(2)),
                latency: prev.latency,
                dropped: prev.dropped,
              }))
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
              const paintMs = performance.now() - receivedAt
              setHasFrame(true)
              setMetrics((prev) => ({ ...prev, latency: Math.round(paintMs) }))
            }).catch(() => {})
            return
          }
          let message
          try { message = JSON.parse(event.data) } catch { return }
          if (message.type === 'hello') {
            setMeta({
              width: message.width || 0,
              height: message.height || 0,
              srcWidth: message.srcWidth || 0,
              srcHeight: message.srcHeight || 0,
            })
          }
          if (message.type === 'stats') {
            setMetrics((prev) => ({ ...prev, dropped: Number(message.droppedFrames ?? prev.dropped) }))
          }
        }
        socket.onerror = () => setError('WebSocket 错误')
        socket.onclose = () => {
          socketRef.current = null
          setStatus('offline')
          clearTimeout(reconnectRef.current)
          reconnectRef.current = setTimeout(() => { connect() }, 2500)
        }
      }, [])

      const disconnect = useCallback(() => {
        clearTimeout(reconnectRef.current)
        const socket = socketRef.current
        socketRef.current = null
        if (socket) { try { socket.close(1000, 'user') } catch {} }
        setStatus('offline')
      }, [])

      useEffect(() => {
        connect()
        return () => {
          clearTimeout(reconnectRef.current)
          const socket = socketRef.current
          socketRef.current = null
          if (socket) { try { socket.close(1000, 'unmount') } catch {} }
          const bitmap = bitmapRef.current
          if (bitmap && bitmap.close) bitmap.close()
          bitmapRef.current = null
        }
      }, [connect])

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
        const text = draft
        if (!text || !controlRef.current) return
        sendAction({ type: 'type', text })
        setDraft('')
      }, [draft, sendAction])

      /* ---------------- 派生文案 ---------------- */
      const statusText = status === 'live'
        ? t('live')
        : status === 'connecting' ? t('connecting') : t('offline')
      const dotColor = status === 'live'
        ? 'var(--dsw-alias-state-success-primary)'
        : status === 'connecting' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-idle-primary)'

      return h('div', { style: styles.root },
        h('div', { style: styles.bar },
          h('span', { style: styles.title }, t('title')),
          h('span', { style: styles.subtitle }, t('subtitle')),
          h('span', { style: styles.spacer }),
          h('span', { style: styles.pill },
            h('span', { style: { ...styles.dot, background: dotColor } }),
            statusText,
          ),
          meta.srcWidth > 0 && h('span', { style: styles.pill },
            `${t('source')} ${meta.srcWidth}×${meta.srcHeight}`),
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
          !hasFrame && h('div', { style: styles.placeholder }, t('empty')),
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
        ),
        error ? h('div', { style: { ...styles.hint, color: 'var(--dsw-alias-label-error)' } }, error)
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
