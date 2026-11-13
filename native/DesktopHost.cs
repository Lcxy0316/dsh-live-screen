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

    // CharSet.Unicode 不能用默认值：默认按 ANSI 封送字符串字段，而 CreateProcessW
    // 按 UTF-16 解读 lpDesktop，于是得到一个不存在的桌面名 —— 进程能起来但
    // user32 初始化失败，退出码 0xC0000142 (STATUS_DLL_INIT_FAILED)。
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

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

    // ── 私有桌面（v3 T2 隔离）─────────────────────────────────────────────
    // 目标：在用户看不见的地方开一个「自己的桌面」，进程跑在里面，
    // AI 的点击/打字只落到那里，用户的真鼠标和前台窗口一动不动。
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SwitchDesktop(IntPtr h);
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr OpenInputDesktop(int flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetThreadDesktop(IntPtr h);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool EnumDesktopWindows(IntPtr desk, EnumProc cb, IntPtr p);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
        IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr h, uint code);

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
    // ── 私有桌面 ─────────────────────────────────────────────────────────────
    // 一个 DeskScope = 一个用 CreateDesktopW 开出来的桌面 + 一个绑在上面的工作线程。
    // 所有「往那个桌面投递消息」的操作都必须在这个工作线程上做：
    // PostMessage 跨桌面会被静默丢弃（不报错，画面就是不变），这是 v3 最隐蔽的坑。
    class DeskScope
    {
        public string Name = "";
        public IntPtr Desk = IntPtr.Zero;
        public bool Bound;
        public int BindError;
        public string LastError = "";
        public readonly List<IntPtr> Processes = new List<IntPtr>();
        public readonly List<int> Pids = new List<int>();
        public int PointerX, PointerY;      // AI 在这个桌面里的逻辑光标
        public bool TakenOver;
        IntPtr _back = IntPtr.Zero;

        readonly Queue<Action> _q = new Queue<Action>();
        Thread _worker;
        bool _stop;

        public bool Create(string name)
        {
            Name = string.IsNullOrEmpty(name) ? ("lsa-" + Environment.TickCount.ToString("x")) : name;
            Desk = CreateDesktopW(Name, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000 /*GENERIC_ALL*/, IntPtr.Zero);
            if (Desk == IntPtr.Zero) { LastError = "create-failed:" + Marshal.GetLastWin32Error(); return false; }
            _back = OpenInputDesktop(0, false, 0x01FF);
            _worker = new Thread(Loop);
            _worker.IsBackground = true;
            _worker.Start();
            // 等工作线程完成 SetThreadDesktop，否则第一批注入可能落到用户桌面上。
            for (int i = 0; i < 100 && !Bound && BindError == 0; i++) Thread.Sleep(10);
            if (!Bound) { LastError = "bind-failed:" + BindError; return false; }
            return true;
        }

        void Loop()
        {
            Bound = SetThreadDesktop(Desk);
            if (!Bound) { BindError = Marshal.GetLastWin32Error(); return; }
            while (true)
            {
                Action a = null;
                lock (_q)
                {
                    while (_q.Count == 0 && !_stop) Monitor.Wait(_q);
                    if (_stop) return;
                    a = _q.Dequeue();
                }
                try { a(); } catch { }
            }
        }

        /// 在私有桌面的线程上执行；超时返回 false（绝不无限等，避免卡住采集循环）。
        public bool Run(Action body, int timeoutMs = 4000)
        {
            if (Desk == IntPtr.Zero) { body(); return true; }
            if (!Bound) return false;
            var done = new ManualResetEventSlim(false);
            lock (_q) { _q.Enqueue(delegate { try { body(); } finally { done.Set(); } }); Monitor.Pulse(_q); }
            bool ok = done.Wait(timeoutMs);
            done.Dispose();
            return ok;
        }

        public T Eval<T>(Func<T> body, T fallback, int timeoutMs = 4000)
        {
            T result = fallback;
            Run(delegate { result = body(); }, timeoutMs);
            return result;
        }

        public bool Spawn(string exe, string args)
        {
            string full = ResolveExe(exe);
            if (full == null) { LastError = "exe-not-found"; return false; }
            var si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            si.lpDesktop = "winsta0\\" + Name;
            PROCESS_INFORMATION pi;
            string inner = string.IsNullOrEmpty(args) ? "\"" + full + "\"" : "\"" + full + "\" " + args;
            // 必须经 cmd.exe 中转。Chromium 系（Edge / Electron / 豆包）会用 ShellExecute
            // 自重启，直接从宿主 CreateProcess 时子进程落到用户桌面上、启动器自己退出 0x15。
            // 经 cmd 中转后子进程继承 cmd 的桌面 = 私有桌面，实测 Edge 正常起窗。
            string shell = Path.Combine(Environment.SystemDirectory, "cmd.exe");
            string cmd = "\"" + shell + "\" /c " + inner;
            bool ok = CreateProcessW(shell, cmd, IntPtr.Zero, IntPtr.Zero, false,
                0x00000010 /*CREATE_NEW_CONSOLE：给 cmd 一个自己的控制台，在私有桌面上，用户看不见*/,
                IntPtr.Zero, null, ref si, out pi);
            if (!ok) { LastError = "spawn-failed:" + Marshal.GetLastWin32Error(); return false; }
            CloseHandle(pi.hThread);
            // cmd 立刻退出说明那条命令行根本没跑起来（引号/路径问题），要把退出码摊出来，
            // 否则外面只会看到「ok:true 但桌面上什么都没有」。
            if (WaitForSingleObject(pi.hProcess, 1200) == 0)
            {
                uint code;
                GetExitCodeProcess(pi.hProcess, out code);
                CloseHandle(pi.hProcess);
                LastError = "shell-exited:0x" + code.ToString("x") + " cmdline=" + inner;
                return false;
            }
            Processes.Add(pi.hProcess); Pids.Add(pi.dwProcessId);
            return true;
        }

        public List<Win> Windows(bool visibleOnly)
        {
            var list = new List<Win>();
            if (Desk == IntPtr.Zero) return list;
            EnumDesktopWindows(Desk, delegate(IntPtr h, IntPtr p)
            {
                if (visibleOnly && !IsWindowVisible(h)) return true;
                if (!IsWindow(h)) return true;
                RECT r;
                if (!GetWindowRect(h, out r)) return true;
                int w = r.Right - r.Left, hh = r.Bottom - r.Top;
                if (w < 80 || hh < 60) return true;
                int len = GetWindowTextLengthW(h);
                var sb = new StringBuilder(Math.Max(len + 1, 8));
                GetWindowTextW(h, sb, sb.Capacity);
                var cls = new StringBuilder(256);
                GetClassNameW(h, cls, cls.Capacity);
                uint pid; GetWindowThreadProcessId(h, out pid);
                var win = new Win();
                win.Hwnd = h; win.Title = sb.ToString(); win.Cls = cls.ToString(); win.Pid = pid;
                win.X = r.Left; win.Y = r.Top; win.W = w; win.H = hh;
                win.Minimized = IsIconic(h); win.Cloaked = false; win.Enabled = IsWindowEnabled(h);
                list.Add(win);
                return true;
            }, IntPtr.Zero);
            return list;
        }

        public IntPtr Foreground()
        {
            return Eval<IntPtr>(delegate { return GetForegroundWindow(); }, IntPtr.Zero);
        }

        /// 逻辑光标位置命中的窗口（z-order 顶在前，第一个包含该点的就是目标）。
        public IntPtr HitTest(int x, int y)
        {
            foreach (var w in Windows(true))
            {
                if (w.Minimized) continue;
                if (x >= w.X && y >= w.Y && x < w.X + w.W && y < w.Y + w.H) return w.Hwnd;
            }
            return IntPtr.Zero;
        }

        /// 把用户切到这个桌面（接管）：SwitchDesktop 换输入桌面，SetThreadDesktop 换线程绑定，
        /// 两者都做，SendInput 才会被接受（实测只做前者仍然 ACCESS_DENIED）。
        public bool Takeover()
        {
            if (Desk == IntPtr.Zero) return false;
            bool ok = false;
            var t = new Thread(delegate()
            {
                if (!SwitchDesktop(Desk)) { LastError = "switch:" + Marshal.GetLastWin32Error(); return; }
                Thread.Sleep(150);
                if (!SetThreadDesktop(Desk)) { LastError = "bind:" + Marshal.GetLastWin32Error(); return; }
                ok = true;
            });
            t.IsBackground = true;
            t.Start();
            if (!t.Join(3000)) { LastError = "takeover-timeout"; return false; }
            TakenOver = ok;
            if (ok) HoldBackFor(8000);
            return ok;
        }

        /// 安全网：接管期间如果调用方崩了，8 秒后自动把用户放回自己的桌面。
        void HoldBackFor(int ms)
        {
            IntPtr back = _back;
            var guard = new Thread(delegate()
            {
                Thread.Sleep(ms);
                if (TakenOver && back != IntPtr.Zero) { SwitchDesktop(back); TakenOver = false; }
            });
            guard.IsBackground = true;
            guard.Start();
        }

        public bool Release()
        {
            if (!TakenOver) return true;
            bool ok = _back != IntPtr.Zero && SwitchDesktop(_back);
            TakenOver = false;
            return ok;
        }

        public void Close()
        {
            Release();
            // 子进程是 cmd.exe 的孩子，TerminateProcess(cmd) 不会带走它 ——
            // 所以先把私有桌面上的窗口所属进程杀掉，再收尾。
            try
            {
                foreach (var w in Windows(false))
                {
                    if (w.Pid == 0) continue;
                    try { Process.GetProcessById((int)w.Pid).Kill(); } catch { }
                }
            }
            catch { }
            foreach (var h in Processes)
            {
                try { TerminateProcess(h, 0); } catch { }
                try { CloseHandle(h); } catch { }
            }
            Processes.Clear();
            lock (_q) { _stop = true; Monitor.Pulse(_q); }
            if (Desk != IntPtr.Zero) { try { CloseDesktop(Desk); } catch { } Desk = IntPtr.Zero; }
            if (_back != IntPtr.Zero) { try { CloseDesktop(_back); } catch { } _back = IntPtr.Zero; }
        }
    }

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
        // 开了私有桌面就只枚举那个桌面上的窗口 —— 用户桌面的窗口对 AI 不可见，
        // 这样「绑定目标」永远不会误绑到用户自己正在用的东西上。
        if (_desk != null && _desk.Desk != IntPtr.Zero) return _desk.Windows(visibleOnly);
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
        public int Mean;                    // 最近一帧的平均亮度 0..255（整桌面合成模式下采样得出）
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
        bool _deskMode;
        byte[] _comp;
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
            _deskMode = false;
            _hwnd = hwnd;
            _srcDc = IntPtr.Zero;
            _w = win.W;
            _h = win.H;
            _attached = Alloc();
            if (!_attached) Detach();
            return _attached;
        }

        /// 整桌面合成：后台桌面上的 GetDC(0) 没有合成表面（BitBlt 直接失败，实测），
        /// 所以只能逐窗口 PrintWindow 再按 z-order 自己拼。
        public bool AttachDesktop()
        {
            Detach();
            _screen = false;
            _deskMode = true;
            _hwnd = IntPtr.Zero;
            _srcDc = IntPtr.Zero;
            _w = GetSystemMetrics(0);
            _h = GetSystemMetrics(1);
            _comp = new byte[_w * _h * 4];
            _attached = Alloc();
            if (!_attached) Detach();
            return _attached;
        }

        class Layer
        {
            public IntPtr Hwnd, Dc, Dib, Bits, Old;
            public int X, Y, W, H;
            public long At;
            public void Free()
            {
                if (Dib != IntPtr.Zero) { SelectObject(Dc, Old); DeleteObject(Dib); DeleteDC(Dc); Dib = IntPtr.Zero; Dc = IntPtr.Zero; Bits = IntPtr.Zero; }
            }
            public bool Ensure(int w, int h)
            {
                if (Dib != IntPtr.Zero && W == w && H == h) return true;
                Free();
                W = w; H = h;
                IntPtr screen = GetDC(IntPtr.Zero);
                Dc = CreateCompatibleDC(screen);
                var bmi = new BITMAPINFO();
                bmi.bmiHeader.biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER));
                bmi.bmiHeader.biWidth = w;
                bmi.bmiHeader.biHeight = -h;
                bmi.bmiHeader.biPlanes = 1;
                bmi.bmiHeader.biBitCount = 32;
                bmi.bmiHeader.biCompression = 0;
                Dib = CreateDIBSection(Dc, ref bmi, 0, out Bits, IntPtr.Zero, 0);
                ReleaseDC(IntPtr.Zero, screen);
                if (Dib == IntPtr.Zero) { DeleteDC(Dc); Dc = IntPtr.Zero; return false; }
                Old = SelectObject(Dc, Dib);
                return true;
            }
        }

        readonly List<Layer> _layers = new List<Layer>();

        bool GrabDesktop()
        {
            var wins = Enumerate(true);
            long now = Environment.TickCount;
            IntPtr fg = (_desk != null) ? _desk.Foreground() : GetForegroundWindow();

            // 缓存策略：焦点窗口每帧重采（它在变），其它窗口 1 秒一次（静态，省 CPU）。
            foreach (var w in wins)
            {
                var layer = null as Layer;
                foreach (var l in _layers) if (l.Hwnd == w.Hwnd) { layer = l; break; }
                if (layer == null) { layer = new Layer(); layer.Hwnd = w.Hwnd; _layers.Add(layer); }
                bool isFg = w.Hwnd == fg;
                if (!isFg && layer.Dib != IntPtr.Zero && now - layer.At < 1000) { layer.X = w.X; layer.Y = w.Y; continue; }
                if (!layer.Ensure(w.W, w.H)) continue;
                for (int i = 0; i < w.W * w.H; i++) Marshal.WriteInt32(layer.Bits, i * 4, 0);
                PrintWindow(w.Hwnd, layer.Dc, PW_RENDERFULLCONTENT);
                layer.At = now; layer.X = w.X; layer.Y = w.Y;
            }

            // 合成：EnumDesktopWindows 是 z-order 顶在前，所以从尾部（最底）往头画。
            int stride = _w * 4;
            for (int i = 0; i < _comp.Length; i += 4)
            {
                _comp[i] = 0x22; _comp[i + 1] = 0x1E; _comp[i + 2] = 0x1A; _comp[i + 3] = 0xFF;  // BGR 深色底
            }
            for (int wi = wins.Count - 1; wi >= 0; wi--)
            {
                var l = null as Layer;
                foreach (var c in _layers) if (c.Hwnd == wins[wi].Hwnd) { l = c; break; }
                if (l == null || l.Dib == IntPtr.Zero) continue;
                IntPtr bits = l.Bits;
                // 逐行拷贝 + 目标矩形裁剪（窗口可能超出屏幕 / 被拖到负坐标）
                int srcX = 0, srcY = 0, dstX = l.X, dstY = l.Y, cw = l.W, ch = l.H;
                if (dstX < 0) { srcX = -dstX; cw += dstX; dstX = 0; }
                if (dstY < 0) { srcY = -dstY; ch += dstY; dstY = 0; }
                if (dstX + cw > _w) cw = _w - dstX;
                if (dstY + ch > _h) ch = _h - dstY;
                if (cw <= 0 || ch <= 0) continue;
                var rowBuf = new byte[cw * 4];
                for (int y = 0; y < ch; y++)
                {
                    Marshal.Copy((IntPtr)(bits.ToInt64() + ((long)(srcY + y) * l.W + srcX) * 4), rowBuf, 0, cw * 4);
                    Buffer.BlockCopy(rowBuf, 0, _comp, ((dstY + y) * _w + dstX) * 4, cw * 4);
                }
            }
            Marshal.Copy(_comp, 0, _bits, _comp.Length);
            // 亮度采样：Chromium 系在后台桌面上不做合成，PrintWindow 会给出近黑表面，
            // 有了这个数字才能判断「到底采到了东西还是黑屏」。
            long sum = 0; int n = 0;
            for (int i = 0; i < _comp.Length; i += 4 * 37)
            {
                sum += (_comp[i] + _comp[i + 1] + _comp[i + 2]) / 3; n++;
            }
            Mean = n > 0 ? (int)(sum / n) : 0;
            return true;
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
            foreach (var l in _layers) l.Free();
            _layers.Clear();
            _comp = null;
            _hwnd = IntPtr.Zero; _screen = false; _deskMode = false; _attached = false;
            _lastTiles = null;
        }

        public void Dispose() { Detach(); }

        public bool Grab()
        {
            if (_dib == IntPtr.Zero) return false;
            if (_deskMode) return GrabDesktop();
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
        // 私有桌面模式下，「前台」和「光标」都是那个桌面的，不是用户桌面的。
        var fg = (_desk != null && _desk.Desk != IntPtr.Zero) ? _desk.Foreground() : GetForegroundWindow();
        sb.Append(",\"foreground\":\"0x" + fg.ToInt64().ToString("x") + "\"");
        if (_desk != null && _desk.Desk != IntPtr.Zero)
        {
            sb.Append(",\"cursor\":{\"x\":" + _desk.PointerX + ",\"y\":" + _desk.PointerY + ",\"virtual\":true}");
            sb.Append(",\"desk\":{\"name\":\"" + Esc(_desk.Name) + "\""
                + ",\"hwnd\":\"0x" + _desk.Desk.ToInt64().ToString("x") + "\""
                + ",\"bound\":" + (_desk.Bound ? "true" : "false")
                + ",\"takenOver\":" + (_desk.TakenOver ? "true" : "false")
                + ",\"pids\":" + _desk.Pids.Count + "}");
        }
        else
        {
            POINT p; GetCursorPos(out p);
            sb.Append(",\"cursor\":{\"x\":" + p.X + ",\"y\":" + p.Y + "}");
        }
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
            sb.Append(",\"capture\":{\"w\":" + cap.W + ",\"h\":" + cap.H + ",\"seq\":" + cap.Seq + ",\"screen\":" + (cap.IsScreen ? "true" : "false") + ",\"mean\":" + cap.Mean + "}");
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
    static DeskScope _desk;             // 非 null 时：采集与注入都限定在这个私有桌面里
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
        if (_desk != null) { try { _desk.Close(); } catch { } _desk = null; }
        _cap.Dispose();
        return 0;
    }

    // 注入路由：有私有桌面时，所有消息必须从「绑在那个桌面上的线程」发出，
// 否则 PostMessage 会被系统静默丢弃（不报错，只是画面永远不变）。
    /**
     * 当前该对谁动手：私有桌面里是那个桌面的前台窗口，否则是绑定的窗口。
     * 只能在桌面线程之外调用（内部会 Run 到桌面线程，桌面线程上再调会自锁）。
     */
    static IntPtr ActionTarget()
    {
        if (_desk != null && _desk.Desk != IntPtr.Zero)
        {
            IntPtr fg = IntPtr.Zero;
            _desk.Run(delegate
            {
                fg = GetForegroundWindow();
                // 私有桌面上常常「没有前台窗口」（没人激活过它），退回最上层可见窗口。
                if (fg == IntPtr.Zero)
                {
                    var wins = _desk.Windows(true);
                    if (wins.Count > 0) fg = wins[0].Hwnd;
                }
            });
            return fg;
        }
        return _target;
    }

    static string Route(Func<string> fn)
    {
        if (_desk == null || _desk.Desk == IntPtr.Zero) return fn();
        string r = "inject-timeout";
        _desk.Run(delegate { r = fn(); });
        return r;
    }

    static void RouteVoid(Action fn)
    {
        if (_desk == null || _desk.Desk == IntPtr.Zero) { fn(); return; }
        _desk.Run(fn);
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

            // ── 私有桌面控制（v3 T2）──────────────────────────────────────
            case "DESK":
            {
                string sub = rest.Trim();
                string arg = "";
                int spp = sub.IndexOf(' ');
                if (spp > 0) { arg = sub.Substring(spp + 1); sub = sub.Substring(0, spp); }
                switch (sub.ToUpperInvariant())
                {
                    case "NEW":
                    {
                        if (_desk != null) { _desk.Close(); _desk = null; }
                        var d = new DeskScope();
                        bool ok = d.Create(arg.Trim());
                        _desk = ok ? d : null;
                        // 新桌面就绪后立刻切到「整桌面合成」模式，这样面板看到的是整个虚拟桌面。
                        if (ok)
                        {
                            _target = IntPtr.Zero;
                            _cap.AttachDesktop();
                            _forceNext = true;
                        }
                        WriteJson("{\"type\":\"desk\",\"ok\":" + (ok ? "true" : "false")
                            + ",\"name\":\"" + Esc(d.Name) + "\""
                            + ",\"hwnd\":\"0x" + d.Desk.ToInt64().ToString("x") + "\""
                            + ",\"error\":\"" + Esc(ok ? "" : d.LastError) + "\""
                            + ",\"w\":" + _cap.W + ",\"h\":" + _cap.H + "}");
                        return true;
                    }
                    case "SPAWN":
                    {
                        if (_desk == null) { WriteJson("{\"type\":\"spawn\",\"ok\":false,\"error\":\"no-desktop\"}"); return true; }
                        var parts = arg.Split(new[] { '|' }, 2);
                        string exe = parts[0].Trim();
                        // '|' 是协议里的参数分隔符，必须换成空格 —— 否则 cmd 会把它当管道，
                        // Edge 这类程序会以 0x1/0xff 静默退出（踩过一次）
                        string a2 = parts.Length > 1 ? parts[1].Replace('|', ' ') : "";
                        bool ok = _desk.Spawn(exe, a2);
                        WriteJson("{\"type\":\"spawn\",\"ok\":" + (ok ? "true" : "false")
                            + ",\"exe\":\"" + Esc(exe) + "\""
                            + ",\"pid\":" + (_desk.Pids.Count > 0 ? _desk.Pids[_desk.Pids.Count - 1] : 0)
                            + ",\"error\":\"" + Esc(ok ? "" : _desk.LastError) + "\"}");
                        return true;
                    }
                    case "LIST":
                        WriteJson("{\"type\":\"list\",\"desktop\":true,\"windows\":" + ListJson() + "}");
                        return true;
                    case "TAKEOWN":
                    {
                        if (_desk == null) { WriteJson("{\"type\":\"takeover\",\"ok\":false,\"error\":\"no-desktop\"}"); return true; }
                        bool ok = _desk.Takeover();
                        WriteJson("{\"type\":\"takeover\",\"ok\":" + (ok ? "true" : "false")
                            + ",\"active\":true,\"error\":\"" + Esc(ok ? "" : _desk.LastError) + "\"}");
                        return true;
                    }
                    case "RELEASE":
                    {
                        bool ok = _desk == null || _desk.Release();
                        WriteJson("{\"type\":\"takeover\",\"ok\":" + (ok ? "true" : "false") + ",\"active\":false}");
                        return true;
                    }
                    case "CLOSE":
                    {
                        if (_desk != null) { _desk.Close(); _desk = null; }
                        _cap.Detach();
                        _target = IntPtr.Zero;
                        WriteJson("{\"type\":\"deskclosed\"}");
                        return true;
                    }
                    default:
                        WriteJson("{\"type\":\"error\",\"message\":\"unknown-desk-command\"}");
                        return true;
                }
            }

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
                IntPtr hit = IntPtr.Zero;
                if (_desk != null && _desk.Desk != IntPtr.Zero)
                {
                    // 私有桌面：按 z-order 找逻辑光标下最上面的窗口，再 PostMessage 到它。
                    // 只有「接管中」（那个桌面成了输入桌面）才允许走 SendInput。
                    hit = _desk.HitTest(x, y);
                    if (hit == IntPtr.Zero) { WriteJson("{\"type\":\"result\",\"ok\":false,\"detail\":\"no-window-at-point\",\"x\":" + x + ",\"y\":" + y + "}"); return true; }
                    RECT hr; GetWindowRect(hit, out hr);
                    int hx, hy; ClientOffset(hit, out hx, out hy);
                    cx = x - hr.Left - hx; cy = y - hr.Top - hy;
                    _desk.PointerX = x; _desk.PointerY = y;
                }
                else if (_target != IntPtr.Zero)
                {
                    RECT r; GetWindowRect(_target, out r);
                    int dx, dy; ClientOffset(_target, out dx, out dy);
                    sx = r.Left + x; sy = r.Top + y;
                    cx = x - dx; cy = y - dy;
                }
                string r2 = Route(delegate { return InjectClick(hit != IntPtr.Zero ? hit : _target, cx, cy, sx, sy, btn, cmd == "CLICKF" || (hit != IntPtr.Zero && _desk.TakenOver)); });
                if (_desk != null && _desk.Desk != IntPtr.Zero) { _desk.PointerX = sx; _desk.PointerY = sy; }
                WriteJson("{\"type\":\"result\",\"ok\":" + (r2 == "ok" ? "true" : "false") + ",\"detail\":\"" + Esc(r2) + "\",\"x\":" + x + ",\"y\":" + y + ",\"tier\":\"" + (cmd == "CLICKF" ? "L2" : "L1") + "\"}");
                return true;
            }

            case "MOVE":
            {
                var a = rest.Split(' ');
                if (a.Length < 2) { WriteJson("{\"type\":\"result\",\"ok\":false,\"error\":\"bad-args\"}"); return true; }
                int x = int.Parse(a[0], CultureInfo.InvariantCulture);
                int y = int.Parse(a[1], CultureInfo.InvariantCulture);
                if (_desk != null && _desk.Desk != IntPtr.Zero)
                {
                    // 私有桌面里真实光标是共享的（而且 SendInput 会被系统拒），
                    // 所以「移动」只是移动我们自己的逻辑光标，面板画 ghost cursor 即可。
                    _desk.PointerX = x; _desk.PointerY = y;
                    WriteJson("{\"type\":\"result\",\"ok\":true,\"detail\":\"logical\",\"x\":" + x + ",\"y\":" + y + "}");
                    return true;
                }
                int sx = x, sy = y, cx = x, cy = y;
                if (_target != IntPtr.Zero)
                {
                    RECT r; GetWindowRect(_target, out r);
                    int dx, dy; ClientOffset(_target, out dx, out dy);
                    sx = r.Left + x; sy = r.Top + y;
                    cx = x - dx; cy = y - dy;
                }
                string r3 = Route(delegate { return InjectMove(_target, cx, cy, sx, sy, false); });
                // 私有桌面里真实光标是共用的，所以我们自己记一个「AI 的逻辑光标」，
                // 面板据此画 ghost cursor —— 这就是用户要的「独立鼠标」。
                if (_desk != null && _desk.Desk != IntPtr.Zero) { _desk.PointerX = sx; _desk.PointerY = sy; }
                WriteJson("{\"type\":\"result\",\"ok\":" + (r3 == "ok" ? "true" : "false") + ",\"detail\":\"" + Esc(r3) + "\",\"x\":" + sx + ",\"y\":" + sy + "}");
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
                string r4 = Route(delegate { return InjectScroll(_target, cx, cy, dy, false); });
                WriteJson("{\"type\":\"result\",\"ok\":" + (r4 == "ok" ? "true" : "false") + ",\"detail\":\"" + Esc(r4) + "\"}");
                return true;
            }

            case "TYPE":
            case "TYPEF":
            {
                // 私有桌面里没有「绑定的窗口」，收键盘的是那个桌面的前台窗口。
                // 必须在进 Route 之前解析：Route 内部就跑在桌面线程上，再调 Run 会自锁。
                IntPtr tgt = ActionTarget();
                bool forceType = cmd == "TYPEF" || (_desk != null && _desk.TakenOver);
                string r5 = Route(delegate { return InjectText(tgt, rest, forceType); });
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
                string r6 = Route(delegate { return InjectKey(ActionTarget(), vk, down, cmd == "KEYF" || (_desk != null && _desk.TakenOver)); });
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
                // 私有桌面里「置前」也必须在那个桌面的线程上做，否则 SetForegroundWindow 静默无效。
                RouteVoid(delegate { ShowWindow(h2, 9); SetForegroundWindow(h2); });
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
