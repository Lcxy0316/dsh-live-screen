// DesktopHost.cs — dsh-live-screen v2 原生宿主
//
// 设计要点（对应 v2 方案）：
//  1. 采集对象可选：整屏（OPEN SCREEN）或单个窗口（OPEN 0x1a2b），窗口级用 PrintWindow(PW_RENDERFULLCONTENT)
//  2. 注入默认走 PostMessage（不动光标、不抢焦点），失败可显式降级到前台 SendInput
//  3. 每帧在 DIB 上直接算 16×16 分块哈希 → 变化检测 / settle 判定 / 无变化不发帧
//  4. 帧带 seq + 时间戳，可测端到端延迟
//  5. SPAWN 走 Job Object（KILL_ON_JOB_CLOSE），关工作台不残留进程树
//
// 编译：csc.exe（.NET Framework 4.8，C# 5 语法，csc 不认 C# 6+ 特性）
// 用法：DesktopHost.exe [--fps 12] [--quality 55]
//
// stdout 协议：[len u32 LE][type u8][payload]
//   type 1 = 帧：[seq u32][tsMs u32][w u16][h u16][cols u8][rows u8][changedTiles u16][JPEG...]
//   type 2 = JSON UTF-8 文本
// stdin 协议：一行一条 UTF-8 文本命令（见 Dispatch）

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class DesktopHost
{
    // ── P/Invoke ─────────────────────────────────────────────────────────────
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFOHEADER
    {
        public int biSize, biWidth, biHeight;
        public short biPlanes, biBitCount;
        public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFO { public BITMAPINFOHEADER bmiHeader; public int bmiColors; }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public INPUTUNION u; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    delegate bool EnumProc(IntPtr h, IntPtr p);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLengthW(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDC(IntPtr h);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    // 用户最后一次物理输入的时间戳（毫秒，GetTickCount 口径）——ControlLease 抢占检测靠它。
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("kernel32.dll")] static extern uint GetTickCount();
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowW(string cls, string title);
    [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint mapType);
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);

    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFO bmi, uint usage, out IntPtr bits, IntPtr hSection, uint offset);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr sec, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    const uint PW_RENDERFULLCONTENT = 0x2;
    const uint WM_MOUSEMOVE = 0x0200;
    const uint WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
    const uint WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205;
    const uint WM_MBUTTONDOWN = 0x0207, WM_MBUTTONUP = 0x0208;
    const uint WM_MOUSEWHEEL = 0x020A;
    const uint WM_CHAR = 0x0102;
    const uint WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101;
    const uint WM_CLOSE = 0x0010;
    const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int JobObjectExtendedLimitInformation = 9;

    // ── 输出 ─────────────────────────────────────────────────────────────────
    static Stream _out;
    static readonly object _outLock = new object();

    static void WriteFrame(byte[] payload)
    {
        lock (_outLock)
        {
            var lenBuf = new byte[4];
            int len = payload.Length + 1;
            lenBuf[0] = (byte)(len & 0xFF); lenBuf[1] = (byte)((len >> 8) & 0xFF);
            lenBuf[2] = (byte)((len >> 16) & 0xFF); lenBuf[3] = (byte)((len >> 24) & 0xFF);
            _out.Write(lenBuf, 0, 4);
            _out.WriteByte(1);
            _out.Write(payload, 0, payload.Length);
            _out.Flush();
        }
    }

    static void WriteJson(string json)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        lock (_outLock)
        {
            var lenBuf = new byte[4];
            int len = bytes.Length + 1;
            lenBuf[0] = (byte)(len & 0xFF); lenBuf[1] = (byte)((len >> 8) & 0xFF);
            lenBuf[2] = (byte)((len >> 16) & 0xFF); lenBuf[3] = (byte)((len >> 24) & 0xFF);
            _out.Write(lenBuf, 0, 4);
            _out.WriteByte(2);
            _out.Write(bytes, 0, bytes.Length);
            _out.Flush();
        }
    }

    static string Esc(string s)
    {
        if (s == null) return "";
        var sb = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') { sb.Append('\\'); sb.Append(c); }
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else if (c < 0x20) { sb.Append("\\u"); sb.Append(((int)c).ToString("x4")); }
            else sb.Append(c);
        }
        return sb.ToString();
    }

    // ── 窗口枚举 ─────────────────────────────────────────────────────────────
    class Win
    {
        public IntPtr Hwnd;
        public string Title, Cls;
        public uint Pid;
        public int X, Y, W, H;
        public bool Minimized, Cloaked, Enabled;
        public long Area { get { return (long)W * H; } }
    }

    static List<Win> Enumerate(bool visibleOnly)
    {
        var list = new List<Win>();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (visibleOnly && !IsWindowVisible(h)) return true;
            int len = GetWindowTextLengthW(h);
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            int w = r.Right - r.Left, hh = r.Bottom - r.Top;
            if (w < 80 || hh < 60) return true;
            var sb = new StringBuilder(Math.Max(len + 1, 8));
            GetWindowTextW(h, sb, sb.Capacity);
            var cls = new StringBuilder(256);
            GetClassNameW(h, cls, cls.Capacity);
            uint pid; GetWindowThreadProcessId(h, out pid);
            int cloaked = 0;
            try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }
            var win = new Win();
            win.Hwnd = h; win.Title = sb.ToString(); win.Cls = cls.ToString(); win.Pid = pid;
            win.X = r.Left; win.Y = r.Top; win.W = w; win.H = hh;
            win.Minimized = IsIconic(h); win.Cloaked = cloaked != 0; win.Enabled = IsWindowEnabled(h);
            list.Add(win);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    static Win Find(IntPtr hwnd)
    {
        foreach (var w in Enumerate(false)) if (w.Hwnd == hwnd) return w;
        return null;
    }

    // ── 采集器 ───────────────────────────────────────────────────────────────
    class Frame
    {
        public int Seq;
        public uint TsMs;
        public int W, H, Cols, Rows, Changed;
        public byte[] Jpeg;
        public uint[] Tiles;
    }

    class Capturer : IDisposable
    {
        public int Fps = 12;
        public int Quality = 55;
        public bool Attached { get { return _attached; } }
        public bool IsScreen { get { return _screen; } }
        public int W { get { return _w; } }
        public int H { get { return _h; } }
        public int Seq { get { return _seq; } }
        public uint[] LastTiles { get { return _lastTiles; } }
        public int Cols { get { return _cols; } }
        public int Rows { get { return _rows; } }

        IntPtr _hwnd = IntPtr.Zero;
        bool _screen;
        bool _attached;
        int _w, _h, _seq, _cols, _rows;
        IntPtr _memDc = IntPtr.Zero, _dib = IntPtr.Zero, _bits = IntPtr.Zero, _old = IntPtr.Zero, _srcDc = IntPtr.Zero;
        uint[] _lastTiles;
        byte[] _buf;

        const int TILE_GRID = 16;

        public bool AttachScreen()
        {
            Detach();
            _screen = true;
            _hwnd = IntPtr.Zero;
            _srcDc = GetDC(IntPtr.Zero);
            _w = GetSystemMetrics(0);
            _h = GetSystemMetrics(1);
            _attached = Alloc();
            if (!_attached) Detach();
            return _attached;
        }

        public bool AttachWindow(IntPtr hwnd)
        {
            Detach();
            var win = Find(hwnd);
            if (win == null) return false;
            _screen = false;
            _hwnd = hwnd;
            _srcDc = IntPtr.Zero;
            _w = win.W;
            _h = win.H;
            _attached = Alloc();
            if (!_attached) Detach();
            return _attached;
        }

        bool Alloc()
        {
            if (_w <= 0 || _h <= 0) return false;
            IntPtr dc = _srcDc != IntPtr.Zero ? _srcDc : GetDC(IntPtr.Zero);
            _memDc = CreateCompatibleDC(dc);
            var bmi = new BITMAPINFO();
            bmi.bmiHeader.biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER));
            bmi.bmiHeader.biWidth = _w;
            bmi.bmiHeader.biHeight = -_h;
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = 0;
            IntPtr bits;
            _dib = CreateDIBSection(_memDc, ref bmi, 0, out bits, IntPtr.Zero, 0);
            if (_dib == IntPtr.Zero) return false;
            _bits = bits;
            _old = SelectObject(_memDc, _dib);
            _cols = TILE_GRID; _rows = TILE_GRID;
            _lastTiles = new uint[_cols * _rows];
            _buf = new byte[_w * 4 * _h];
            if (_srcDc == IntPtr.Zero) ReleaseDC(IntPtr.Zero, dc);
            return true;
        }

        public void Resize()
        {
            if (_screen) return;
            if (!Attached) return;
            var win = Find(_hwnd);
            if (win == null) return;
            if (win.W == _w && win.H == _h) return;
            Detach();
            _srcDc = IntPtr.Zero;
            _w = win.W; _h = win.H;
            Alloc();
        }

        public void Detach()
        {
            if (_old != IntPtr.Zero) { SelectObject(_memDc, _old); _old = IntPtr.Zero; }
            if (_dib != IntPtr.Zero) { DeleteObject(_dib); _dib = IntPtr.Zero; }
            if (_memDc != IntPtr.Zero) { DeleteDC(_memDc); _memDc = IntPtr.Zero; }
            if (_srcDc != IntPtr.Zero) { ReleaseDC(IntPtr.Zero, _srcDc); _srcDc = IntPtr.Zero; }
            _hwnd = IntPtr.Zero; _screen = false; _attached = false;
            _lastTiles = null;
        }

        public void Dispose() { Detach(); }

        public bool Grab()
        {
            if (_dib == IntPtr.Zero) return false;
            if (_screen)
            {
                bool ok = BitBlt(_memDc, 0, 0, _w, _h, _srcDc, 0, 0, 0x00CC0020);
                return ok;
            }
            var win = Find(_hwnd);
            if (win == null) return false;
            if (win.W != _w || win.H != _h) Resize();
            if (_dib == IntPtr.Zero) return false;
            // 先清空，便于识别「PrintWindow 什么都没写」
            for (int i = 0; i < _w * _h; i++) Marshal.WriteInt32(_bits, i * 4, 0);
            return PrintWindow(_hwnd, _memDc, PW_RENDERFULLCONTENT);
        }

        public uint[] ComputeTiles(out int changed)
        {
            int stride = _w * 4;
            Marshal.Copy(_bits, _buf, 0, _buf.Length);
            var tiles = new uint[_cols * _rows];
            for (int ty = 0; ty < _rows; ty++)
            {
                int y0 = (int)((long)_h * ty / _rows), y1 = (int)((long)_h * (ty + 1) / _rows);
                for (int tx = 0; tx < _cols; tx++)
                {
                    int x0 = (int)((long)_w * tx / _cols), x1 = (int)((long)_w * (tx + 1) / _cols);
                    uint h = 2166136261u;
                    for (int y = y0; y < y1; y += 3)
                    {
                        int row = y * stride;
                        for (int x = x0; x < x1; x += 3)
                        {
                            int o = row + x * 4;
                            h = (h ^ _buf[o]) * 16777619u;
                            h = (h ^ _buf[o + 1]) * 16777619u;
                            h = (h ^ _buf[o + 2]) * 16777619u;
                        }
                    }
                    tiles[ty * _cols + tx] = h;
                }
            }
            changed = 0;
            if (_lastTiles == null) changed = tiles.Length;
            else for (int i = 0; i < tiles.Length; i++) if (tiles[i] != _lastTiles[i]) changed++;
            return tiles;
        }

        public byte[] EncodeJpeg()
        {
            using (var bmp = new Bitmap(_w, _h, _w * 4, PixelFormat.Format32bppRgb, _bits))
            {
                var codec = GetEncoder(ImageFormat.Jpeg);
                var ps = new EncoderParameters(1);
                ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Quality);
                using (var ms = new MemoryStream())
                {
                    bmp.Save(ms, codec, ps);
                    return ms.ToArray();
                }
            }
        }

        public Frame Produce(bool force, out bool didEncode)
        {
            didEncode = false;
            if (!Grab()) return null;
            int changed;
            var tiles = ComputeTiles(out changed);
            if (!force && changed == 0) { _lastTiles = tiles; return null; }
            var jpeg = EncodeJpeg();
            _lastTiles = tiles;
            _seq++;
            var f = new Frame();
            f.Seq = _seq;
            f.TsMs = (uint)Environment.TickCount;
            f.W = _w; f.H = _h; f.Cols = _cols; f.Rows = _rows;
            f.Changed = changed;
            f.Jpeg = jpeg;
            f.Tiles = tiles;
            didEncode = true;
            return f;
        }

        public static uint[] TilesOf(Frame f) { return f == null ? null : f.Tiles; }
    }

    static ImageCodecInfo GetEncoder(ImageFormat format)
    {
        foreach (var c in ImageCodecInfo.GetImageEncoders())
            if (c.FormatID == format.Guid) return c;
        return null;
    }

    static void SendFrame(Capturer cap, Frame f)
    {
        var head = new byte[16];
        WriteU32(head, 0, (uint)f.Seq);
        WriteU32(head, 4, f.TsMs);
        head[8] = (byte)(f.W & 0xFF); head[9] = (byte)((f.W >> 8) & 0xFF);
        head[10] = (byte)(f.H & 0xFF); head[11] = (byte)((f.H >> 8) & 0xFF);
        head[12] = (byte)f.Cols; head[13] = (byte)f.Rows;
        head[14] = (byte)(f.Changed & 0xFF); head[15] = (byte)((f.Changed >> 8) & 0xFF);
        var payload = new byte[16 + f.Jpeg.Length];
        Buffer.BlockCopy(head, 0, payload, 0, 16);
        Buffer.BlockCopy(f.Jpeg, 0, payload, 16, f.Jpeg.Length);
        WriteFrame(payload);
    }

    static void WriteU32(byte[] b, int o, uint v)
    {
        b[o] = (byte)(v & 0xFF); b[o + 1] = (byte)((v >> 8) & 0xFF);
        b[o + 2] = (byte)((v >> 16) & 0xFF); b[o + 3] = (byte)((v >> 24) & 0xFF);
    }

    // ── 注入 ─────────────────────────────────────────────────────────────────
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);

    // 图像坐标 → 窗口客户区坐标（PostMessage 用）
    // 图像是整窗（含边框/标题栏），客户区左上角相对窗口左上角有 (dx,dy) 偏移
    static void ClientOffset(IntPtr hwnd, out int dx, out int dy)
    {
        dx = 0; dy = 0;
        if (hwnd == IntPtr.Zero) return;
        RECT wr; GetClientRect(hwnd, out wr);
        var p = new POINT(); p.X = 0; p.Y = 0;
        ClientToScreen(hwnd, ref p);
        RECT r; GetWindowRect(hwnd, out r);
        dx = p.X - r.Left;
        dy = p.Y - r.Top;
    }

    static IntPtr LParam(int x, int y) { return (IntPtr)((y << 16) | (x & 0xFFFF)); }

    // cx,cy = 客户区坐标（PostMessage 用）；sx,sy = 屏幕坐标（SendInput 用）
    static string InjectClick(IntPtr hwnd, int cx, int cy, int sx, int sy, string button, bool forceForeground)
    {
        if (hwnd == IntPtr.Zero) return "no-target";
        if (!IsWindow(hwnd)) return "window-gone";
        if (!IsWindowEnabled(hwnd)) return "window-disabled";

        if (forceForeground)
        {
            ShowWindow(hwnd, 9);
            SetForegroundWindow(hwnd);
            Thread.Sleep(60);
            SetCursorPos(sx, sy);
            Thread.Sleep(30);
            var arr = new INPUT[2];
            uint down = button == "right" ? MOUSEEVENTF_RIGHTDOWN : button == "middle" ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN;
            uint up = button == "right" ? MOUSEEVENTF_RIGHTUP : button == "middle" ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP;
            arr[0].type = INPUT_MOUSE; arr[0].u.mi.dwFlags = down;
            arr[1].type = INPUT_MOUSE; arr[1].u.mi.dwFlags = up;
            uint sent = SendInput(2, arr, Marshal.SizeOf(typeof(INPUT)));
            return sent == 2 ? "ok" : "sendinput-failed";
        }

        uint dMsg = button == "right" ? WM_RBUTTONDOWN : button == "middle" ? WM_MBUTTONDOWN : WM_LBUTTONDOWN;
        uint uMsg = button == "right" ? WM_RBUTTONUP : button == "middle" ? WM_MBUTTONUP : WM_LBUTTONUP;
        IntPtr lp = LParam(cx, cy);
        bool a = PostMessage(hwnd, WM_MOUSEMOVE, IntPtr.Zero, lp);
        Thread.Sleep(20);
        bool b = PostMessage(hwnd, dMsg, (IntPtr)1, lp);
        Thread.Sleep(15);
        bool c = PostMessage(hwnd, uMsg, IntPtr.Zero, lp);
        if (!a || !b || !c) return "post-failed";
        return "ok";
    }

    static string InjectMove(IntPtr hwnd, int cx, int cy, int sx, int sy, bool forceForeground)
    {
        if (hwnd == IntPtr.Zero) return "no-target";
        if (forceForeground) { SetCursorPos(sx, sy); return "ok"; }
        return PostMessage(hwnd, WM_MOUSEMOVE, IntPtr.Zero, LParam(cx, cy)) ? "ok" : "post-failed";
    }

    static string InjectScroll(IntPtr hwnd, int cx, int cy, int dy, bool forceForeground)
    {
        if (hwnd == IntPtr.Zero) return "no-target";
        if (forceForeground)
        {
            var arr = new INPUT[1];
            arr[0].type = INPUT_MOUSE;
            arr[0].u.mi.mouseData = (uint)dy;
            arr[0].u.mi.dwFlags = MOUSEEVENTF_WHEEL;
            return SendInput(1, arr, Marshal.SizeOf(typeof(INPUT))) == 1 ? "ok" : "sendinput-failed";
        }
        IntPtr wp = (IntPtr)((dy << 16) & 0xFFFF0000);
        return PostMessage(hwnd, WM_MOUSEWHEEL, wp, LParam(cx, cy)) ? "ok" : "post-failed";
    }

    static string InjectText(IntPtr hwnd, string text, bool forceForeground)
    {
        if (hwnd == IntPtr.Zero) return "no-target";
        if (forceForeground)
        {
            ShowWindow(hwnd, 9);
            SetForegroundWindow(hwnd);
            Thread.Sleep(80);
            int sent = 0;
            foreach (char ch in text)
            {
                var arr = new INPUT[2];
                arr[0].type = INPUT_KEYBOARD; arr[0].u.ki.wScan = ch; arr[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
                arr[1].type = INPUT_KEYBOARD; arr[1].u.ki.wScan = ch; arr[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
                arr[0].u.ki.wVk = 0; arr[1].u.ki.wVk = 0;
                if (SendInput(2, arr, Marshal.SizeOf(typeof(INPUT))) == 2) sent++;
                Thread.Sleep(6);
            }
            return sent == text.Length ? "ok" : "partial:" + sent + "/" + text.Length;
        }
        int ok = 0;
        foreach (char ch in text)
        {
            if (PostMessage(hwnd, WM_CHAR, (IntPtr)ch, (IntPtr)1)) ok++;
            Thread.Sleep(6);
        }
        return ok == text.Length ? "ok" : "partial:" + ok + "/" + text.Length;
    }

    static string InjectKey(IntPtr hwnd, int vk, bool down, bool forceForeground)
    {
        if (hwnd == IntPtr.Zero) return "no-target";
        uint scan = MapVirtualKeyW((uint)vk, 0);
        if (forceForeground)
        {
            var arr = new INPUT[1];
            arr[0].type = INPUT_KEYBOARD;
            arr[0].u.ki.wVk = (ushort)vk;
            arr[0].u.ki.wScan = (ushort)scan;
            arr[0].u.ki.dwFlags = down ? 0u : KEYEVENTF_KEYUP;
            return SendInput(1, arr, Marshal.SizeOf(typeof(INPUT))) == 1 ? "ok" : "sendinput-failed";
        }
        // lParam: bit0 repeat=1, bit16-23 scan, bit30 previous state, bit31 transition(up)
        // 必须按 32 位有符号整数再转 IntPtr —— x64 上要符号扩展，否则 bit31 判定失效
        int lpI = unchecked((int)(1u | ((uint)scan << 16) | (down ? 0u : 0xC0000000u)));
        IntPtr lp = (IntPtr)lpI;
        bool ok = PostMessage(hwnd, down ? WM_KEYDOWN : WM_KEYUP, (IntPtr)vk, lp);
        return ok ? "ok" : "post-failed";
    }

    // ── Job Object ───────────────────────────────────────────────────────────
    static IntPtr _job = IntPtr.Zero;
    static readonly List<int> _jobPids = new List<int>();

    static IntPtr EnsureJob()
    {
        if (_job != IntPtr.Zero) return _job;
        _job = CreateJobObjectW(IntPtr.Zero, null);
        if (_job == IntPtr.Zero) return IntPtr.Zero;
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(_job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
        return _job;
    }

    // 把 "calc" / "notepad.exe" 解析成绝对路径：先试原样，再按 PATH + 系统目录 + .exe 后缀补全。
    static string ResolveExe(string exe)
    {
        if (string.IsNullOrWhiteSpace(exe)) return null;
        exe = exe.Trim().Trim('"');
        if (File.Exists(exe)) return Path.GetFullPath(exe);

        var names = new List<string>();
        names.Add(exe);
        if (!exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) names.Add(exe + ".exe");

        var dirs = new List<string>();
        foreach (var d in new[] { Environment.SystemDirectory, Environment.GetFolderPath(Environment.SpecialFolder.Windows) })
            if (!string.IsNullOrEmpty(d)) dirs.Add(d);
        var pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var d in pathVar.Split(';'))
            if (!string.IsNullOrWhiteSpace(d)) dirs.Add(d.Trim());

        foreach (var dir in dirs)
        {
            foreach (var n in names)
            {
                try
                {
                    var full = Path.Combine(dir, n);
                    if (File.Exists(full)) return full;
                }
                catch { }
            }
        }
        return null;
    }

    static string Spawn(string exe, string args)
    {
        try
        {
            string full = ResolveExe(exe);
            if (full == null) return "{\"ok\":false,\"error\":\"exe-not-found\",\"exe\":\"" + Esc(exe) + "\"}";
            var psi = new ProcessStartInfo(full);
            if (!string.IsNullOrEmpty(args)) psi.Arguments = args;
            psi.UseShellExecute = false;
            psi.WorkingDirectory = Path.GetDirectoryName(full);
            var proc = Process.Start(psi);
            if (proc == null) return "{\"ok\":false,\"error\":\"start-failed\"}";
            var job = EnsureJob();
            bool assigned = false;
            if (job != IntPtr.Zero)
            {
                IntPtr h = OpenProcess(0x0100 /*PROCESS_SET_QUOTA*/ | 0x0200 /*PROCESS_TERMINATE*/, false, (uint)proc.Id);
                if (h != IntPtr.Zero)
                {
                    assigned = AssignProcessToJobObject(job, h);
                    CloseHandle(h);
                }
            }
            _jobPids.Add(proc.Id);
            return "{\"ok\":true,\"pid\":" + proc.Id + ",\"assigned\":" + (assigned ? "true" : "false") + "}";
        }
        catch (Exception ex)
        {
            return "{\"ok\":false,\"error\":\"" + Esc(ex.Message) + "\"}";
        }
    }

    static string KillJob()
    {
        int n = 0;
        if (_job != IntPtr.Zero && TerminateJobObject(_job, 1)) n = _jobPids.Count;
        else
        {
            foreach (int pid in _jobPids)
            {
                try { Process.GetProcessById(pid).Kill(); n++; } catch { }
            }
        }
        _jobPids.Clear();
        return "{\"ok\":true,\"killed\":" + n + "}";
    }

    // ── 状态探针 ─────────────────────────────────────────────────────────────
    static string ProbeJson(Capturer cap, IntPtr target)
    {
        var sb = new StringBuilder();
        sb.Append("{\"t\":" + Environment.TickCount);
        var fg = GetForegroundWindow();
        sb.Append(",\"foreground\":\"0x" + fg.ToInt64().ToString("x") + "\"");
        POINT p; GetCursorPos(out p);
        sb.Append(",\"cursor\":{\"x\":" + p.X + ",\"y\":" + p.Y + "}");
        // 空闲时长：用户多久没动过真鼠标/键盘。ControlLease 用它判断是否被用户抢占。
        var lii = new LASTINPUTINFO(); lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (GetLastInputInfo(ref lii))
        {
            uint idle = unchecked(GetTickCount() - lii.dwTime);
            sb.Append(",\"idleMs\":" + idle);
        }
        sb.Append(",\"target\":\"0x" + target.ToInt64().ToString("x") + "\"");
        if (cap != null && cap.Attached)
        {
            sb.Append(",\"capture\":{\"w\":" + cap.W + ",\"h\":" + cap.H + ",\"seq\":" + cap.Seq + ",\"screen\":" + (cap.IsScreen ? "true" : "false") + "}");
            var tiles = cap.LastTiles;
            if (tiles != null)
            {
                var changed = new List<string>();
                for (int i = 0; i < tiles.Length; i++) if (tiles[i] != 0) changed.Add(i.ToString());
                sb.Append(",\"tiles\":{\"cols\":" + cap.Cols + ",\"rows\":" + cap.Rows + "}");
            }
        }
        sb.Append(",\"windows\":[");
        var wins = Enumerate(true);
        bool first = true;
        foreach (var w in wins)
        {
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"hwnd\":\"0x" + w.Hwnd.ToInt64().ToString("x") + "\"");
            sb.Append(",\"title\":\"" + Esc(w.Title) + "\"");
            sb.Append(",\"cls\":\"" + Esc(w.Cls) + "\"");
            sb.Append(",\"pid\":" + w.Pid);
            sb.Append(",\"rect\":[" + w.X + "," + w.Y + "," + w.W + "," + w.H + "]");
            sb.Append(",\"minimized\":" + (w.Minimized ? "true" : "false"));
            sb.Append(",\"cloaked\":" + (w.Cloaked ? "true" : "false"));
            sb.Append(",\"enabled\":" + (w.Enabled ? "true" : "false"));
            sb.Append(",\"focused\":" + (w.Hwnd == fg ? "true" : "false"));
            sb.Append('}');
        }
        sb.Append("]}");
        return sb.ToString();
    }

    static string ListJson()
    {
        var sb = new StringBuilder("[");
        bool first = true;
        foreach (var w in Enumerate(true))
        {
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"hwnd\":\"0x" + w.Hwnd.ToInt64().ToString("x") + "\"");
            sb.Append(",\"title\":\"" + Esc(w.Title) + "\"");
            sb.Append(",\"cls\":\"" + Esc(w.Cls) + "\"");
            sb.Append(",\"pid\":" + w.Pid);
            sb.Append(",\"rect\":[" + w.X + "," + w.Y + "," + w.W + "," + w.H + "]");
            sb.Append(",\"minimized\":" + (w.Minimized ? "true" : "false"));
            sb.Append(",\"cloaked\":" + (w.Cloaked ? "true" : "false"));
            sb.Append('}');
        }
        sb.Append(']');
        return sb.ToString();
    }

    // ── 主循环 ───────────────────────────────────────────────────────────────
    static Capturer _cap = new Capturer();
    static IntPtr _target = IntPtr.Zero;
    static volatile bool _running = true;
    static readonly ManualResetEventSlim _wake = new ManualResetEventSlim(false);
    static volatile bool _forceNext = true;

    static void CaptureLoop()
    {
        while (_running)
        {
            int fps = _cap.Fps;
            if (fps < 1) fps = 1;
            if (fps > 60) fps = 60;
            int frameMs = 1000 / fps;
            var sw = Stopwatch.StartNew();
            try
            {
                if (_cap.Attached)
                {
                    bool force = _forceNext;
                    _forceNext = false;
                    bool encoded;
                    var f = _cap.Produce(force, out encoded);
                    if (f != null) SendFrame(_cap, f);
                }
            }
            catch (Exception ex)
            {
                WriteJson("{\"type\":\"error\",\"where\":\"capture\",\"message\":\"" + Esc(ex.Message) + "\"}");
                Thread.Sleep(500);
            }
            int rest = frameMs - (int)sw.ElapsedMilliseconds;
            if (rest < 1) rest = 1;
            _wake.Wait(rest);
            _wake.Reset();
        }
    }

    static IntPtr ParseHwnd(string s)
    {
        if (string.IsNullOrEmpty(s)) return IntPtr.Zero;
        long v;
        if (long.TryParse(s.Replace("0x", ""), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v)) return (IntPtr)v;
        return IntPtr.Zero;
    }

    static int Main(string[] args)
    {
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }
        try { SetProcessDpiAwarenessContext((IntPtr)(-4)); }
        catch { try { SetProcessDPIAware(); } catch { } }

        int fps = 12, quality = 55;
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--fps") int.TryParse(args[i + 1], out fps);
            if (args[i] == "--quality") int.TryParse(args[i + 1], out quality);
        }
        _cap.Fps = fps; _cap.Quality = quality;

        _out = Console.OpenStandardOutput();

        var capThread = new Thread(CaptureLoop);
        capThread.IsBackground = true;
        capThread.Start();

        WriteJson("{\"type\":\"ready\",\"fps\":" + fps + ",\"quality\":" + quality + ",\"pid\":" + Process.GetCurrentProcess().Id + "}");

        var stdin = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            line = line.TrimEnd('\r', '\n');
            if (line.Length == 0) continue;
            try
            {
                if (!Dispatch(line)) break;
            }
            catch (Exception ex)
            {
                WriteJson("{\"type\":\"error\",\"where\":\"dispatch\",\"message\":\"" + Esc(ex.Message) + "\"}");
            }
        }
        _running = false;
        _wake.Set();
        _cap.Dispose();
        return 0;
    }

    // 返回 false 表示退出
    static bool Dispatch(string line)
    {
        int sp = line.IndexOf(' ');
        string cmd = sp < 0 ? line.ToUpperInvariant() : line.Substring(0, sp).ToUpperInvariant();
        string rest = sp < 0 ? "" : line.Substring(sp + 1);

        switch (cmd)
        {
            case "QUIT":
                return false;

            case "OPEN":
            {
                if (rest.Trim().ToUpperInvariant() == "SCREEN")
                {
                    _target = IntPtr.Zero;
                    bool ok = _cap.AttachScreen();
                    _forceNext = true;
                    WriteJson("{\"type\":\"opened\",\"ok\":" + (ok ? "true" : "false") + ",\"target\":\"screen\",\"w\":" + _cap.W + ",\"h\":" + _cap.H + "}");
                    return true;
                }
                var h = ParseHwnd(rest.Trim());
                if (h == IntPtr.Zero) { WriteJson("{\"type\":\"opened\",\"ok\":false,\"error\":\"bad-hwnd\"}"); return true; }
                var win = Find(h);
                if (win == null) { WriteJson("{\"type\":\"opened\",\"ok\":false,\"error\":\"window-not-found\"}"); return true; }
                _target = h;
                bool ok2 = _cap.AttachWindow(h);
                _forceNext = true;
                WriteJson("{\"type\":\"opened\",\"ok\":" + (ok2 ? "true" : "false") + ",\"target\":\"0x" + h.ToInt64().ToString("x") + "\",\"title\":\"" + Esc(win.Title) + "\",\"w\":" + _cap.W + ",\"h\":" + _cap.H + "}");
                return true;
            }

            case "CLOSE":
                _cap.Detach();
                _target = IntPtr.Zero;
                WriteJson("{\"type\":\"closed\"}");
                return true;

            case "LIST":
                WriteJson("{\"type\":\"list\",\"windows\":" + ListJson() + "}");
                return true;

            case "PROBE":
                WriteJson("{\"type\":\"probe\"," + ProbeJson(_cap, _target).Substring(1));
                return true;

            case "FRAME":
                _forceNext = true;
                _wake.Set();
                WriteJson("{\"type\":\"frame-forced\"}");
                return true;

            case "FPS":
            {
                int v; if (int.TryParse(rest.Trim(), out v)) _cap.Fps = v;
                WriteJson("{\"type\":\"fps\",\"fps\":" + _cap.Fps + "}");
                return true;
            }

            case "QUALITY":
            case "Q":
            {
                int v; if (int.TryParse(rest.Trim(), out v)) _cap.Quality = Math.Max(20, Math.Min(95, v));
                WriteJson("{\"type\":\"quality\",\"quality\":" + _cap.Quality + "}");
                return true;
            }

            case "CLICK":
            case "CLICKF":
            {
                var a = rest.Split(' ');
                if (a.Length < 2) { WriteJson("{\"type\":\"result\",\"ok\":false,\"error\":\"bad-args\"}"); return true; }
                int x = int.Parse(a[0], CultureInfo.InvariantCulture);
                int y = int.Parse(a[1], CultureInfo.InvariantCulture);
                string btn = a.Length > 2 ? a[2] : "left";
                // 图像坐标 = 整窗相对坐标（含边框标题栏）
                //   -> 屏幕坐标 = 窗口左上 + 图像坐标（SendInput 用）
                //   -> 客户区坐标 = 图像坐标 - (客户区左上 - 窗口左上)（PostMessage 用）
                int sx = x, sy = y, cx = x, cy = y;
                if (_target != IntPtr.Zero)
                {
                    RECT r; GetWindowRect(_target, out r);
                    int dx, dy; ClientOffset(_target, out dx, out dy);
                    sx = r.Left + x; sy = r.Top + y;
                    cx = x - dx; cy = y - dy;
                }
                string r2 = InjectClick(_target, cx, cy, sx, sy, btn, cmd == "CLICKF");
                WriteJson("{\"type\":\"result\",\"ok\":" + (r2 == "ok" ? "true" : "false") + ",\"detail\":\"" + Esc(r2) + "\",\"x\":" + x + ",\"y\":" + y + ",\"tier\":\"" + (cmd == "CLICKF" ? "L2" : "L1") + "\"}");
                return true;
            }

            case "MOVE":
            {
                var a = rest.Split(' ');
                if (a.Length < 2) { WriteJson("{\"type\":\"result\",\"ok\":false,\"error\":\"bad-args\"}"); return true; }
                int x = int.Parse(a[0], CultureInfo.InvariantCulture);
                int y = int.Parse(a[1], CultureInfo.InvariantCulture);
                int sx = x, sy = y, cx = x, cy = y;
                if (_target != IntPtr.Zero)
                {
                    RECT r; GetWindowRect(_target, out r);
                    int dx, dy; ClientOffset(_target, out dx, out dy);
                    sx = r.Left + x; sy = r.Top + y;
                    cx = x - dx; cy = y - dy;
                }
                string r3 = InjectMove(_target, cx, cy, sx, sy, false);
                WriteJson("{\"type\":\"result\",\"ok\":" + (r3 == "ok" ? "true" : "false") + ",\"detail\":\"" + Esc(r3) + "\"}");
                return true;
            }

            case "SCROLL":
            {
                int dy; int.TryParse(rest.Trim(), out dy);
                int cx = 0, cy = 0;
                if (_target != IntPtr.Zero)
                {
                    RECT cr; GetClientRect(_target, out cr);
                    cx = cr.Right / 2; cy = cr.Bottom / 2;   // 滚到窗口中央，避免落在边缘
                }
                string r4 = InjectScroll(_target, cx, cy, dy, false);
                WriteJson("{\"type\":\"result\",\"ok\":" + (r4 == "ok" ? "true" : "false") + ",\"detail\":\"" + Esc(r4) + "\"}");
                return true;
            }

            case "TYPE":
            case "TYPEF":
            {
                string r5 = InjectText(_target, rest, cmd == "TYPEF");
                WriteJson("{\"type\":\"result\",\"ok\":" + (r5 == "ok" ? "true" : "false") + ",\"detail\":\"" + Esc(r5) + "\",\"chars\":" + rest.Length + "}");
                return true;
            }

            case "KEY":
            case "KEYF":
            {
                var a = rest.Split(' ');
                if (a.Length < 2) { WriteJson("{\"type\":\"result\",\"ok\":false,\"error\":\"bad-args\"}"); return true; }
                int vk = int.Parse(a[0], CultureInfo.InvariantCulture);
                bool down = a[1].ToLowerInvariant() == "d" || a[1].ToLowerInvariant() == "down";
                string r6 = InjectKey(_target, vk, down, cmd == "KEYF");
                WriteJson("{\"type\":\"result\",\"ok\":" + (r6 == "ok" ? "true" : "false") + ",\"detail\":\"" + Esc(r6) + "\"}");
                return true;
            }

            case "FOCUS":
            {
                IntPtr h2 = IntPtr.Zero;
                string t = rest.Trim();
                if (t.StartsWith("0x")) h2 = ParseHwnd(t);
                if (h2 == IntPtr.Zero)
                {
                    h2 = FindWindowW(null, t);
                    if (h2 == IntPtr.Zero)
                    {
                        var all = Enumerate(true);
                        foreach (var w in all) if (w.Title.IndexOf(t, StringComparison.OrdinalIgnoreCase) >= 0) { h2 = w.Hwnd; break; }
                    }
                }
                if (h2 == IntPtr.Zero) { WriteJson("{\"type\":\"result\",\"ok\":false,\"detail\":\"not-found\"}"); return true; }
                ShowWindow(h2, 9);
                SetForegroundWindow(h2);
                WriteJson("{\"type\":\"result\",\"ok\":true,\"hwnd\":\"0x" + h2.ToInt64().ToString("x") + "\"}");
                return true;
            }

            case "SPAWN":
            {
                // SPAWN exe|arg1|arg2
                var parts = rest.Split('|');
                string exe = parts[0].Trim();
                var sbArgs = new StringBuilder();
                for (int i = 1; i < parts.Length; i++)
                {
                    if (sbArgs.Length > 0) sbArgs.Append(' ');
                    sbArgs.Append(parts[i]);
                }
                WriteJson("{\"type\":\"spawn\"," + Spawn(exe, sbArgs.ToString()).Substring(1));
                return true;
            }

            case "KILLJOB":
                WriteJson("{\"type\":\"killjob\"," + KillJob().Substring(1));
                return true;

            case "METRICS":
            {
                var p = Process.GetCurrentProcess();
                p.Refresh();
                WriteJson("{\"type\":\"metrics\",\"wsMB\":" + (p.WorkingSet64 / 1048576.0).ToString("F1", CultureInfo.InvariantCulture)
                    + ",\"privMB\":" + (p.PrivateMemorySize64 / 1048576.0).ToString("F1", CultureInfo.InvariantCulture)
                    + ",\"frames\":" + _cap.Seq + ",\"attached\":" + (_cap.Attached ? "true" : "false") + "}");
                return true;
            }

            default:
                WriteJson("{\"type\":\"error\",\"error\":\"unknown-command\",\"cmd\":\"" + Esc(cmd) + "\"}");
                return true;
        }
    }
}
