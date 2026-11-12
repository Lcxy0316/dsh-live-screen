/**
 * DesktopHost.exe 的 Node 侧客户端。
 *
 * 协议（二进制，全部走 stdout）：
 *   [len u32 LE][type u8][payload]
 *   type 1 = 帧：payload = [seq u32][tsMs u32][w u16][h u16][cols u8][rows u8][changedTiles u16][JPEG...]
 *   type 2 = JSON 文本
 *
 * stdin 是行文本命令：OPEN / CLOSE / LIST / PROBE / FRAME / FPS / QUALITY / CLICK / MOVE /
 * SCROLL / TYPE / KEY / FOCUS / SPAWN / KILLJOB / METRICS / QUIT。
 *
 * 这层刻意保持「薄」：不做业务判断，只负责进程生命周期、帧缓存、命令-应答配对。
 * @module dsh-live-screen/host
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const HOST_EXE = path.join(PKG_ROOT, 'native', 'bin', 'DesktopHost.exe')
export const HOST_SRC = path.join(PKG_ROOT, 'native', 'DesktopHost.cs')

/** 单帧上限，超过就是协议错乱。 */
const MAX_FRAME = 8 * 1024 * 1024

export function hostAvailable () {
  return existsSync(HOST_EXE)
}

/**
 * 一个 DesktopHost 进程。
 * 事件：`frame`(frame) `json`(object) `exit`({code,signal})
 */
export class DesktopHost extends EventEmitter {
  constructor (options = {}) {
    super()
    this.options = options
    this.child = null
    this.buffer = Buffer.alloc(0)
    /** 命令-应答等待队列（FIFO，可并发）。 */
    this.waiters = []
    this.latest = null
    this.latestAt = 0
    this.frames = 0
    this.bytes = 0
    this.lastError = null
    this.stopping = false
    this.startedAt = 0
    this.log = []
  }

  get running () {
    return this.child !== null && this.child.exitCode === null && !this.child.killed
  }

  start () {
    if (this.running) return true
    if (!hostAvailable()) {
      this.lastError = `缺少原生宿主 ${HOST_EXE}，先跑 scripts/build-native.ps1`
      return false
    }
    this.stopping = false
    this.buffer = Buffer.alloc(0)
    const child = spawn(HOST_EXE, this.options.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    this.startedAt = Date.now()

    child.stdout.on('data', (chunk) => this.#onData(chunk))
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim()
      if (!text) return
      this.log.push(text)
      if (this.log.length > 60) this.log.shift()
      this.emit('log', text)
    })
    child.on('error', (error) => {
      this.lastError = error?.message ?? String(error)
      this.emit('error', error)
    })
    child.on('exit', (code, signal) => {
      this.child = null
      const stopping = this.stopping
      // 进程没了，所有等待中的请求都必须立刻失败，否则调用方会卡到超时。
      const pending = this.waiters
      this.waiters = []
      for (const waiter of pending) waiter.reject?.(new Error(`宿主已退出 code=${code}`))
      this.emit('exit', { code, signal, stopping })
    })
    return true
  }

  #onData (chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    for (;;) {
      if (this.buffer.length < 4) return
      const len = this.buffer.readUInt32LE(0)
      if (len <= 0 || len > MAX_FRAME) {
        // 协议错乱：丢弃整块缓冲，等下一帧重新对齐。
        this.buffer = Buffer.alloc(0)
        this.lastError = `帧长度异常 ${len}`
        return
      }
      if (this.buffer.length < 4 + len) return
      const type = this.buffer[4]
      const payload = this.buffer.subarray(5, 4 + len)
      this.buffer = this.buffer.subarray(4 + len)
      if (type === 1) this.#onFrame(payload)
      else if (type === 2) this.#onJson(payload)
    }
  }

  #onFrame (payload) {
    if (payload.length < 16) return
    const frame = {
      seq: payload.readUInt32LE(0),
      ts: payload.readUInt32LE(4),
      width: payload.readUInt16LE(8),
      height: payload.readUInt16LE(10),
      cols: payload[12],
      rows: payload[13],
      changed: payload.readUInt16LE(14),
      jpeg: payload.subarray(16),
      at: Date.now()
    }
    if (frame.jpeg.length === 0) return
    this.latest = frame
    this.latestAt = frame.at
    this.frames += 1
    this.bytes += frame.jpeg.length
    this.emit('frame', frame)
  }

  #onJson (payload) {
    let value
    try {
      value = JSON.parse(payload.toString('utf8'))
    } catch {
      return
    }
    if (value.type === 'error') this.lastError = value.message ?? value.error ?? 'unknown'
    this.emit('json', value)
    // 命令-应答配对：应答是 FIFO 的，所以按注册顺序找第一个匹配的等待者。
    // 这里必须支持并发（探针 100ms 一次 + 动作同时在等），否则后来的请求会把前一个挤掉。
    for (let i = 0; i < this.waiters.length; i++) {
      const waiter = this.waiters[i]
      if (waiter.match(value)) {
        this.waiters.splice(i, 1)
        waiter.resolve(value)
        return
      }
    }
  }

  /** 写一行命令；进程不在就抛错。 */
  command (line) {
    if (!this.running) throw new Error('原生宿主未运行')
    this.child.stdin.write(String(line).replace(/[\r\n]+/g, ' ') + '\n')
  }

  /** 等一条满足条件的 JSON 应答。 */
  waitFor (match, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve: null, reject: null }
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error(`等待应答超时：${String(match)}`))
      }, timeoutMs)
      waiter.resolve = (value) => { clearTimeout(timer); resolve(value) }
      waiter.reject = (error) => { clearTimeout(timer); reject(error) }
      this.waiters.push(waiter)
    })
  }

  /**
   * 发命令并等对应的 JSON 应答。
   * 命令名与应答 type 的映射由调用方给出，例如 `command('PROBE', 'probe')`。
   */
  async request (line, replyType, timeoutMs = 8000) {
    const pending = this.waitFor((v) => v.type === replyType, timeoutMs)
    this.command(line)
    return await pending
  }

  /** 等一帧新画面；`force` 会先命令宿主强制编码一帧。 */
  nextFrame ({ force = false, timeoutMs = 6000, after = this.frames } = {}) {
    if (force) {
      try { this.command('FRAME') } catch {}
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('frame', onFrame)
        resolve(null)
      }, timeoutMs)
      const onFrame = (frame) => {
        if (frame.seq === after && !force) return
        clearTimeout(timer)
        this.off('frame', onFrame)
        resolve(frame)
      }
      if (this.latest && force === false && this.frames > after) {
        clearTimeout(timer)
        resolve(this.latest)
        return
      }
      this.on('frame', onFrame)
    })
  }

  /** 抓一帧新鲜画面（强制编码，确保拿到的不是缓存）。 */
  async grab (timeoutMs = 6000) {
    const before = this.frames
    const frame = await this.nextFrame({ force: true, timeoutMs, after: before })
    return frame
  }

  stats () {
    const memory = process.memoryUsage()
    return {
      running: this.running,
      frames: this.frames,
      bytes: this.bytes,
      avgKB: this.frames ? Number((this.bytes / this.frames / 1024).toFixed(1)) : 0,
      lastFrameAgeMs: this.latestAt ? Date.now() - this.latestAt : null,
      width: this.latest?.width ?? 0,
      height: this.latest?.height ?? 0,
      uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      lastError: this.lastError,
      rssMB: Number((memory.rss / 1048576).toFixed(1)),
      heapMB: Number((memory.heapUsed / 1048576).toFixed(1)),
      log: this.log.slice(-10)
    }
  }

  async stop (timeoutMs = 1200) {
    if (!this.running) return
    this.stopping = true
    try { this.command('QUIT') } catch {}
    const child = this.child
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill() } catch {}
        resolve()
      }, timeoutMs)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}

/** 编译原生宿主（csc 在 .NET Framework 目录里，本机一定有）。 */
export async function buildHost () {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const csc = process.env.LSA_CSC ??
    path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  if (!existsSync(csc)) throw new Error(`找不到 csc：${csc}`)
  mkdirSync(path.dirname(HOST_EXE), { recursive: true })
  await run(csc, [
    '/nologo', '/target:exe', '/optimize+', '/platform:anycpu',
    `/out:${HOST_EXE}`,
    '/r:System.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
    HOST_SRC
  ], { windowsHide: true, timeout: 120000 })
  if (!existsSync(HOST_EXE)) throw new Error('编译结束但没有产物')
  return HOST_EXE
}
