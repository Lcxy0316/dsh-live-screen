// 零依赖 WebSocket 服务端实现（RFC 6455 最小子集）。
// 只支持：文本帧、二进制帧、分片、ping/pong、close。
// 用途：宿主插件在 DSH 自己的 webServer 上升级出一条同源 WS，
// 把采集器的 JPEG 帧推给浏览器，同时接收浏览器的控制指令。
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 单个连接的读写状态机。 */
export class WsConnection extends EventEmitter {
  constructor (socket, req) {
    super()
    this.socket = socket
    this.req = req
    this.closed = false
    this._buf = Buffer.alloc(0)
    this._fragments = []
    this._fragOpcode = 0
    this.remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`

    socket.on('data', (chunk) => this._onData(chunk))
    socket.on('close', () => this._finish())
    socket.on('error', () => this._finish())
    socket.setNoDelay(true)
  }

  _finish () {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }

  _onData (chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk
    for (;;) {
      if (this._buf.length < 2) return
      const b0 = this._buf[0]
      const b1 = this._buf[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let offset = 2

      if (len === 126) {
        if (this._buf.length < offset + 2) return
        len = this._buf.readUInt16BE(offset)
        offset += 2
      } else if (len === 127) {
        if (this._buf.length < offset + 8) return
        const hi = this._buf.readUInt32BE(offset)
        const lo = this._buf.readUInt32BE(offset + 4)
        if (hi !== 0) { this.close(1009, 'frame too large'); return }
        len = lo
        offset += 8
      }

      let maskKey = null
      if (masked) {
        if (this._buf.length < offset + 4) return
        maskKey = this._buf.subarray(offset, offset + 4)
        offset += 4
      }

      if (this._buf.length < offset + len) return

      let payload = this._buf.subarray(offset, offset + len)
      this._buf = this._buf.subarray(offset + len)

      if (maskKey) {
        const out = Buffer.allocUnsafe(len)
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3]
        payload = out
      }

      if (opcode === 0x8) { this.close(1000, ''); return }
      if (opcode === 0x9) { this._send(0xA, payload); continue }
      if (opcode === 0xA) { this.emit('pong'); continue }

      if (opcode === 0x0) {
        this._fragments.push(payload)
        if (fin) {
          const full = Buffer.concat(this._fragments)
          const op = this._fragOpcode
          this._fragments = []
          this._fragOpcode = 0
          this._dispatch(op, full)
        }
        continue
      }

      if (!fin) {
        this._fragOpcode = opcode
        this._fragments = [payload]
        continue
      }

      this._dispatch(opcode, payload)
    }
  }

  _dispatch (opcode, payload) {
    if (opcode === 0x1) {
      this.emit('message', payload.toString('utf8'), false)
    } else if (opcode === 0x2) {
      this.emit('message', payload, true)
    }
  }

  _send (opcode, payload) {
    if (this.closed || this.socket.destroyed) return false
    const len = payload.length
    let header
    if (len < 126) {
      header = Buffer.allocUnsafe(2)
      header[0] = 0x80 | opcode
      header[1] = len
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.allocUnsafe(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeUInt32BE(0, 2)
      header.writeUInt32BE(len, 6)
    }
    try {
      // 写队列积压时丢弃这一帧，避免内存被慢客户端拖爆。
      if (this.socket.writableLength > 4 * 1024 * 1024) return false
      this.socket.write(header)
      this.socket.write(payload)
      return true
    } catch {
      this._finish()
      return false
    }
  }

  sendBinary (buf) { return this._send(0x2, buf) }
  sendText (str) { return this._send(0x1, Buffer.from(str, 'utf8')) }

  ping () { return this._send(0x9, Buffer.alloc(0)) }

  close (code = 1000, reason = '') {
    if (this.closed) return
    const r = Buffer.from(reason, 'utf8')
    const payload = Buffer.allocUnsafe(2 + r.length)
    payload.writeUInt16BE(code, 0)
    r.copy(payload, 2)
    this._send(0x8, payload)
    try { this.socket.end() } catch {}
    this._finish()
  }
}

/**
 * 把一条已经升级的 socket 包装成 WsConnection。
 * 宿主 webServer 的 registerUpgrade handler 会把原始 socket 交给我们，
 * 握手响应必须由这里写。
 */
export function upgradeToWebSocket (req, socket, head) {
  const key = req.headers['sec-websocket-key']
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return null
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64')
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n'
  ]
  socket.write(lines.join('\r\n'))
  const conn = new WsConnection(socket, req)
  if (head && head.length) conn._onData(head)
  return conn
}
