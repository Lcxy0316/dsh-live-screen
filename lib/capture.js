// 采集器子进程桥：spawn 原生 ScreenHub.exe，读长度前缀的 JPEG 帧，
// 通过 stdin 文本协议下发鼠标键盘指令。
//
// 原生程序的 stdout 是纯二进制流（4 字节小端长度 + JPEG 字节），
// stderr 是日志与 READY 行 —— 两条流严格分开，避免编码污染帧数据。
import { spawn, execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 包根目录（lib/ 的上一级）。 */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 编译产物位置。 */
export const EXE_PATH = path.join(PKG_ROOT, 'native', 'bin', 'ScreenHub.exe')
/** C# 源码位置。 */
export const SRC_PATH = path.join(PKG_ROOT, 'native', 'ScreenHub.cs')
/** .NET Framework 自带编译器；Windows 11 一定有。 */
const CSC_PATH = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'

/** 采集器是否已经就绪（exe 存在）。 */
export function captureAvailable () {
  return existsSync(EXE_PATH)
}

/**
 * 用系统自带的 csc.exe 把 C# 源码编译成 exe。
 * 故意不依赖 .NET SDK：Windows 11 家庭版默认只有运行时。
 * @returns 编译后的 exe 路径。
 */
export async function buildCapture () {
  if (!existsSync(SRC_PATH)) throw new Error(`找不到采集器源码: ${SRC_PATH}`)
  if (!existsSync(CSC_PATH)) throw new Error(`找不到 C# 编译器: ${CSC_PATH}`)
  // csc 会把默认 Win32 资源写成输出目录下的 .TMP；目录不存在就 CS1567。
  await mkdir(path.dirname(EXE_PATH), { recursive: true })
  const { stdout, stderr } = await execFileAsync(CSC_PATH, [
    '/nologo',
    '/target:exe',
    '/optimize+',
    '/platform:anycpu',
    `/out:${EXE_PATH}`,
    '/r:System.dll',
    '/r:System.Drawing.dll',
    '/r:System.Windows.Forms.dll',
    SRC_PATH
  ], { windowsHide: true, timeout: 120_000 })
  if (!existsSync(EXE_PATH)) {
    throw new Error(`编译未产出 exe。stdout=${stdout.slice(0, 400)} stderr=${stderr.slice(0, 400)}`)
  }
  return EXE_PATH
}

/** 采集器桥。事件：ready / frame(jpeg, timestamp) / error / exit。 */
export class ScreenCapture extends EventEmitter {
  constructor (options = {}) {
    super()
    this.exePath = options.exePath ?? EXE_PATH
    this.fps = options.fps ?? 12
    this.scale = options.scale ?? 1
    this.quality = options.quality ?? 55
    this.proc = null
    this.width = 0
    this.height = 0
    this.srcWidth = 0
    this.srcHeight = 0
    this.frames = 0
    this.bytes = 0
    this.ready = false
    this.lastFrameAt = 0
    this.startedAt = 0
    this._buf = Buffer.alloc(0)
    this._log = []
    this._frameInterval = 0
    this._exit = null
    this._stopping = false
  }

  start () {
    if (this.proc) return this
    if (!existsSync(this.exePath)) throw new Error(`采集器不存在: ${this.exePath}`)
    this._stopping = false
    this._exit = null
    this._buf = Buffer.alloc(0)
    this.startedAt = Date.now()
    const proc = spawn(this.exePath, [
      '--mode', 'stream',
      '--fps', String(this.fps),
      '--scale', String(this.scale),
      '--quality', String(this.quality)
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.proc = proc

    proc.stdout.on('data', (chunk) => this._onStdout(chunk))
    proc.stderr.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line) continue
        this._log.push(line)
        if (this._log.length > 60) this._log.shift()
        if (line.startsWith('READY')) this._onReady(line)
      }
    })
    proc.on('error', (error) => {
      this._exit = { error: error.message }
      this.proc = null
      this.ready = false
      this.emit('error', error)
    })
    proc.on('exit', (code, signal) => {
      this._exit = { code, signal }
      const wasStopping = this._stopping
      this.proc = null
      this.ready = false
      this.emit('exit', { code, signal, stopping: wasStopping })
    })
    return this
  }

  _onReady (line) {
    const info = {}
    for (const part of line.split(' ').slice(1)) {
      const [key, value] = part.split('=')
      if (key) info[key] = Number(value)
    }
    this.width = info.width ?? 0
    this.height = info.height ?? 0
    this.srcWidth = info.srcw ?? 0
    this.srcHeight = info.srch ?? 0
    this.ready = true
    this.emit('ready', {
      width: this.width,
      height: this.height,
      srcWidth: this.srcWidth,
      srcHeight: this.srcHeight
    })
  }

  _onStdout (chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk
    for (;;) {
      if (this._buf.length < 4) return
      const length = this._buf.readUInt32LE(0)
      if (length === 0 || length > 8 * 1024 * 1024) {
        this._buf = Buffer.alloc(0)
        this.emit('error', new Error(`帧长度异常: ${length}`))
        return
      }
      if (this._buf.length < 4 + length) return
      const jpeg = this._buf.subarray(4, 4 + length)
      this._buf = this._buf.subarray(4 + length)

      const now = Date.now()
      if (this.lastFrameAt) {
        const dt = now - this.lastFrameAt
        this._frameInterval = this._frameInterval ? this._frameInterval * 0.8 + dt * 0.2 : dt
      }
      this.lastFrameAt = now
      this.frames++
      this.bytes += jpeg.length
      this.emit('frame', jpeg, now)
    }
  }

  get measuredFps () {
    return this._frameInterval ? 1000 / this._frameInterval : 0
  }

  get running () {
    return this.proc !== null
  }

  /** 下发一条文本指令；采集器不在时返回 false。 */
  command (line) {
    const proc = this.proc
    if (!proc || proc.killed) return false
    try {
      proc.stdin.write(String(line).replace(/[\r\n]+/g, ' ') + '\n')
      return true
    } catch {
      return false
    }
  }

  setQuality (quality) {
    this.quality = quality
    return this.command(`Q ${quality}`)
  }

  stop () {
    const proc = this.proc
    if (!proc) return
    this._stopping = true
    try { this.command('QUIT') } catch {}
    setTimeout(() => {
      try { if (!proc.killed) proc.kill() } catch {}
    }, 800)
  }

  get stats () {
    return {
      ready: this.ready,
      running: this.running,
      width: this.width,
      height: this.height,
      srcWidth: this.srcWidth,
      srcHeight: this.srcHeight,
      frames: this.frames,
      bytes: this.bytes,
      fps: Number(this.measuredFps.toFixed(2)),
      targetFps: this.fps,
      scale: this.scale,
      quality: this.quality,
      uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      lastFrameAgeMs: this.lastFrameAt ? Date.now() - this.lastFrameAt : null,
      lastExit: this._exit,
      log: this._log.slice(-8)
    }
  }
}
