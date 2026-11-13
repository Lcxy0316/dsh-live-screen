// DeskProbe — 判定「第二个桌面」这条隔离路线在真机上是否成立。
//
// 要回答的问题：
//   1. 能不能在没有管理员权限的交互会话里 CreateDesktopW 出一个新桌面？
//   2. 能不能让子进程（记事本 / Edge）真的跑在那个桌面上？
//   3. 那个桌面不是当前可见桌面时，PrintWindow 还能不能采到像素？
//   4. 用 PostMessage 往那个桌面上的窗口点击，画面会不会变？（真实鼠标完全不动）
//   5. 整个过程里，用户的前台窗口和光标位置有没有被动过？
//
// 这四条全部为真，才值得把产品改成「桌面级隔离」；有一条不成立就得换方案。
// 输出 JSONL 到 stdout，一行一个结论。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class DeskProbe
{
    // ---------------- P/Invoke ----------------

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }

    // CharSet.Unicode 必须以 W 形式封送字符串字段（lpDesktop 等），
    // 否则默认 ANSI 封送、CreateProcessW 按 UTF-16 解读 -> 得到一个不存在的桌面名，
    // 进程能起来但 user32 初始化失败，退出码 0xC0000142 STATUS_DLL_INIT_FAILED。
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

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);
    [DllImport("user32.dll", SetLastError = true, EntryPoint = "CloseDesktop")]
    static extern bool CloseDesktopSafe(IntPtr h);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SwitchDesktop(IntPtr h);
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr OpenInputDesktop(int flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetThreadDesktop(IntPtr h);
    [DllImport("user32.dll", SetLastError = true, EntryPoint = "GetThreadDesktop")]
    static extern IntPtr GetThreadDesktopSafe(int threadId);
    [DllImport("kernel32.dll")]
    static extern int GetCurrentThreadId();

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumProc proc, IntPtr param);
    delegate bool EnumProc(IntPtr hwnd, IntPtr param);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassNameW(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")]
    static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")]
    static extern IntPtr GetWindowDC(IntPtr hwnd);
    [DllImport("user32.dll")]
    static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")]
    static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
    [DllImport("user32.dll")]
    static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT
    {
        public int dx, dy;
        public uint mouseData, dwFlags, time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT
    {
        public ushort wVk, wScan;
        public uint dwFlags, time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT
    {
        public uint type;   // 0 = mouse, 1 = keyboard
        public INPUTUNION u;
    }

    const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const int SM_CXSCREEN = 0, SM_CYSCREEN = 1;

    [DllImport("gdi32.dll")]
    static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")]
    static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")]
    static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")]
    static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")]
    static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll", SetLastError = true)]
    static extern bool BitBlt(IntPtr dest, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);

    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFOHEADER
    {
        public int biSize, biWidth, biHeight;
        public short biPlanes, biBitCount;
        public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFO { public BITMAPINFOHEADER h; public int c1, c2, c3; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit,
        uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr h, out uint code);

    // ---------------- 消息 ----------------
    const uint WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
    const uint WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_CHAR = 0x0102, WM_CLOSE = 0x0010;

    const uint DESKTOP_ALL = 0x01FF;         // 桌面对象的全部具体权限
    const uint GENERIC_ALL = 0x10000000;
    const uint MAXIMUM_ALLOWED = 0x02000000;
    const uint STANDARD_RIGHTS_REQUIRED = 0x000F0000;
    const uint DESKTOP_READOBJECTS = 0x0001, DESKTOP_CREATEWINDOW = 0x0002, DESKTOP_CREATEMENU = 0x0004;
    const uint DESKTOP_HOOKCONTROL = 0x0008, DESKTOP_JOURNALRECORD = 0x0010, DESKTOP_JOURNALPLAYBACK = 0x0020;
    const uint DESKTOP_ENUMERATE = 0x0040, DESKTOP_WRITEOBJECTS = 0x0080, DESKTOP_SWITCHDESKTOP = 0x0100;

    static string J(string key, object value)
    {
        string s;
        if (value == null) s = "null";
        else if (value is bool) s = (bool)value ? "true" : "false";
        else if (value is int || value is long || value is double) s = Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
        else s = "\"" + Convert.ToString(value).Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        return "\"" + key + "\":" + s;
    }

    static void Emit(bool ok, string label, params string[] pairs)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("{");
        sb.Append(J("ok", ok)).Append(",");
        sb.Append(J("label", label));
        foreach (var p in pairs) { sb.Append(",").Append(p); }
        sb.Append("}");
        Console.Out.WriteLine(sb.ToString());
        Console.Out.Flush();
    }

    static IntPtr MakeLParam(int x, int y) { return (IntPtr)((y << 16) | (x & 0xFFFF)); }

    // ---------------- 采集 ----------------

    sealed class Shot
    {
        public bool Ok;
        public int W, H;
        public double NonBlack, Mean;
        public long Bytes;
        public string Hash;
        public double Ms;
    }

    static Shot Grab(IntPtr hwnd, int w, int h)
    {
        Shot shot = new Shot { W = w, H = h };
        if (hwnd == IntPtr.Zero || w <= 0 || h <= 0) return shot;
        IntPtr screen = GetWindowDC(IntPtr.Zero);
        IntPtr mem = CreateCompatibleDC(screen);
        BITMAPINFO bmi = new BITMAPINFO();
        bmi.h.biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER));
        bmi.h.biWidth = w; bmi.h.biHeight = -h;
        bmi.h.biPlanes = 1; bmi.h.biBitCount = 32;
        IntPtr bits;
        IntPtr dib = CreateDIBSection(mem, ref bmi, 0, out bits, IntPtr.Zero, 0);
        if (dib == IntPtr.Zero) { DeleteDC(mem); ReleaseDC(IntPtr.Zero, screen); return shot; }
        IntPtr old = SelectObject(mem, dib);
        int total = w * h * 4;
        for (int i = 0; i < total; i += 4) Marshal.WriteInt32(bits, i, 0);

        Stopwatch sw = Stopwatch.StartNew();
        shot.Ok = PrintWindow(hwnd, mem, 0x00000002); // PW_RENDERFULLCONTENT
        sw.Stop();
        shot.Ms = sw.Elapsed.TotalMilliseconds;

        byte[] data = new byte[total];
        Marshal.Copy(bits, data, 0, total);

        int lit = 0, samples = 0;
        long sum = 0;
        uint hash = 2166136261u;
        for (int y = 0; y < h; y += 2)
        {
            for (int x = 0; x < w; x += 2)
            {
                int i = (y * w + x) * 4;
                int lum = (data[i + 2] * 299 + data[i + 1] * 587 + data[i] * 114) / 1000;
                samples++;
                sum += lum;
                if (lum > 10) lit++;
                hash = (hash ^ (uint)lum) * 16777619u;
            }
        }
        shot.NonBlack = samples == 0 ? 0 : (double)lit / samples;
        shot.Mean = samples == 0 ? 0 : (double)sum / samples;
        shot.Bytes = total;
        shot.Hash = hash.ToString("x8");

        SelectObject(mem, old);
        DeleteObject(dib);
        DeleteDC(mem);
        ReleaseDC(IntPtr.Zero, screen);
        return shot;
    }

    // ---------------- 窗口枚举（指定桌面） ----------------

    sealed class Win
    {
        public IntPtr Hwnd;
        public string Title, Cls;
        public int X, Y, W, H;
        public bool Minimized;
        public uint Pid;
    }

    static List<Win> EnumerateDesktop(IntPtr desk, int minW = 80, int minH = 60)
    {
        List<Win> list = new List<Win>();
        EnumDesktopWindows(desk, delegate(IntPtr hwnd, IntPtr param)
        {
            if (!IsWindowVisible(hwnd)) return true;
            RECT r;
            if (!GetWindowRect(hwnd, out r)) return true;
            int w = r.Right - r.Left, h = r.Bottom - r.Top;
            if (w < minW || h < minH) return true;
            StringBuilder t = new StringBuilder(512);
            GetWindowTextW(hwnd, t, t.Capacity);
            StringBuilder c = new StringBuilder(256);
            GetClassNameW(hwnd, c, c.Capacity);
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            list.Add(new Win
            {
                Hwnd = hwnd,
                Title = t.ToString(),
                Cls = c.ToString(),
                X = r.Left, Y = r.Top, W = w, H = h,
                Minimized = IsIconic(hwnd),
                Pid = pid
            });
            return true;
        }, IntPtr.Zero);
        return list;
    }

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    // ---------------- 主流程 ----------------

    static Win WaitWindow(IntPtr desk, HashSet<IntPtr> before, int timeoutMs, IntPtr hProcess, out string diag)
    {
        diag = "";
        Stopwatch sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            uint wait = WaitForSingleObject(hProcess, 0);
            if (wait == 0)
            {
                uint exitCode;
                GetExitCodeProcess(hProcess, out exitCode);
                diag = "process-exited exitCode=" + exitCode;
                return null;
            }
            foreach (var w in EnumerateDesktop(desk))
            {
                if (before.Contains(w.Hwnd)) continue;
                if (w.Minimized) continue;
                return w;
            }
            Thread.Sleep(200);
        }
        // 超时：把新桌面上「所有」窗口（含不可见、含小尺寸）摊出来，便于判断卡在哪
        StringBuilder sb = new StringBuilder();
        int total = 0;
        EnumDesktopWindows(desk, delegate(IntPtr hwnd, IntPtr param)
        {
            total++;
            StringBuilder t = new StringBuilder(256);
            GetWindowTextW(hwnd, t, t.Capacity);
            RECT r;
            GetWindowRect(hwnd, out r);
            string cls = "";
            StringBuilder c = new StringBuilder(128);
            GetClassNameW(hwnd, c, c.Capacity);
            cls = c.ToString();
            sb.Append(string.Format("[{0} vis={1} {2}x{3} cls={4} title={5}]",
                hwnd.ToInt64().ToString("x"), IsWindowVisible(hwnd),
                r.Right - r.Left, r.Bottom - r.Top, cls, t.ToString()));
            return true;
        }, IntPtr.Zero);
        diag = "total-windows=" + total + " " + sb.ToString();
        return null;
    }

    /// 在一个独立线程上换桌面：SetThreadDesktop 要求该线程还没建过窗口/钩子。
    /// 注意：换桌面的线程不能用来采集（PrintWindow 会跨桌面失败），只用来投递消息。
    static bool RunOnDesktop(IntPtr desk, Action body)
    {
        bool ok = false;
        Exception error = null;
        Thread t = new Thread(() =>
        {
            try
            {
                if (!SetThreadDesktop(desk))
                    throw new InvalidOperationException("SetThreadDesktop failed " + Marshal.GetLastWin32Error());
                body();
                ok = true;
            }
            catch (Exception ex) { error = ex; }
        });
        t.IsBackground = true;
        t.Start();
        t.Join();
        if (error != null) { Emit(false, "set-thread-desktop", J("error", error.Message)); return false; }
        return ok;
    }

    static string ResolveExe(string name)
    {
        if (name.IndexOf('\\') >= 0 || name.IndexOf('/') >= 0)
            return System.IO.File.Exists(name) ? name : null;
        string[] exts = { "", ".exe" };
        List<string> dirs = new List<string>();
        dirs.Add(Environment.SystemDirectory);
        dirs.Add(Environment.GetFolderPath(Environment.SpecialFolder.Windows));
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var d in path.Split(';')) if (d.Trim().Length > 0) dirs.Add(d.Trim());
        foreach (var d in dirs)
            foreach (var e in exts)
            {
                try
                {
                    string full = System.IO.Path.Combine(d, name + e);
                    if (System.IO.File.Exists(full)) return full;
                }
                catch { }
            }
        return null;
    }

    static int Main(string[] args)
    {
        bool allowSwitch = true;   // --no-switch: 跳过 SwitchDesktop
        bool baseline = false;     // --baseline: lpDesktop 留空，验证 CreateProcessW 本身是否可用
        bool explicitPerm = false; // --perm=explicit: 用显式权限位建桌面，而不是 GENERIC_ALL
        bool noNewConsole = false; // --no-newconsole: 去掉 CREATE_NEW_CONSOLE
        List<string> rest = new List<string>();
        foreach (var a in args)
        {
            if (a == "--no-switch") allowSwitch = false;
            else if (a == "--baseline") baseline = true;
            else if (a == "--perm=explicit") explicitPerm = true;
            else if (a == "--no-newconsole") noNewConsole = true;
            else rest.Add(a);
        }
        args = rest.ToArray();

        string app = args.Length > 0 ? args[0] : "notepad";
        string appArgs = args.Length > 1 ? args[1] : "";
        int timeoutMs = 20000;

        // DPI：必须在任何窗口/坐标调用之前声明，否则 GetSystemMetrics 返回的是缩放后的假尺寸
        // （本机 1920x1080 @125% 会报成 1536x864），坐标全错。
        bool dpiOk = SetProcessDpiAwarenessContext((IntPtr)(-4));  // PER_MONITOR_AWARE_V2
        if (!dpiOk) dpiOk = SetProcessDPIAware();
        Emit(dpiOk, "dpi-aware",
            J("ctx2", dpiOk),
            J("cx", GetSystemMetrics(SM_CXSCREEN)),
            J("cy", GetSystemMetrics(SM_CYSCREEN)));

        // 记录动手之前的状态，稍后证明我们没碰用户的桌面。
        IntPtr fgBefore = GetForegroundWindow();
        POINT curBefore; GetCursorPos(out curBefore);

        string name = "lsa-probe-" + DateTime.Now.Ticks.ToString("x");
        // GENERIC_ALL 有时在受限令牌下被拒；--perm=explicit 用桌面对象的显式权限位。
        uint deskAccess = explicitPerm
            ? (DESKTOP_READOBJECTS | DESKTOP_CREATEWINDOW | DESKTOP_CREATEMENU | DESKTOP_HOOKCONTROL |
               DESKTOP_JOURNALRECORD | DESKTOP_JOURNALPLAYBACK | DESKTOP_ENUMERATE | DESKTOP_WRITEOBJECTS |
               DESKTOP_SWITCHDESKTOP | STANDARD_RIGHTS_REQUIRED)
            : GENERIC_ALL;
        IntPtr desk = CreateDesktopW(name, IntPtr.Zero, IntPtr.Zero, 0, deskAccess, IntPtr.Zero);
        int err = Marshal.GetLastWin32Error();
        Emit(desk != IntPtr.Zero, "create-desktop",
            J("name", name), J("hwnd", "0x" + desk.ToInt64().ToString("x")), J("win32Error", err));
        if (desk == IntPtr.Zero)
        {
            Emit(false, "abort", J("reason", "CreateDesktopW failed"));
            return 1;
        }

        try
        {
            // 这个桌面当前可见吗？（应该是不可见：它没有成为当前输入桌面）
            IntPtr input = OpenInputDesktop(0, false, DESKTOP_ALL);
            Emit(input != IntPtr.Zero && input != desk, "desktop-is-background",
                J("inputDesk", "0x" + input.ToInt64().ToString("x")),
                J("ourDesk", "0x" + desk.ToInt64().ToString("x")));

            HashSet<IntPtr> before = new HashSet<IntPtr>();
            foreach (var w in EnumerateDesktop(desk)) before.Add(w.Hwnd);
            Emit(true, "existing-windows-on-new-desktop", J("count", before.Count));

            // 子进程挂到新桌面
            string resolved = ResolveExe(app);
            if (resolved == null)
            {
                Emit(false, "abort", J("reason", "exe-not-found"), J("exe", app));
                return 1;
            }
            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            // lpDesktop 用 "winsta0\<桌面名>"：只写桌面名时进程会落到默认桌面上。
            si.lpDesktop = baseline ? null : ("winsta0\\" + name);
            PROCESS_INFORMATION pi;
            string cmd = appArgs.Length > 0 ? "\"" + resolved + "\" " + appArgs : "\"" + resolved + "\"";
            uint createFlags = noNewConsole ? 0u : 0x00000010u /*CREATE_NEW_CONSOLE*/;
            bool spawned = CreateProcessW(resolved, cmd, IntPtr.Zero, IntPtr.Zero, false,
                createFlags, IntPtr.Zero, null, ref si, out pi);
            err = Marshal.GetLastWin32Error();
            Emit(spawned, "spawn-on-desktop",
                J("exe", resolved), J("pid", spawned ? pi.dwProcessId : 0), J("win32Error", err));
            if (!spawned)
            {
                Emit(false, "abort", J("reason", "CreateProcessW with lpDesktop failed"));
                return 1;
            }

            // 用户桌面上的进程能不能看见它？（应该看不见）
            List<Win> onUser = new List<Win>();
            IntPtr userDesk = GetThreadDesktopSafe(GetCurrentThreadId());
            // 主线程仍在默认桌面上：用 EnumWindows 之类的等价物做不到「只看默认桌面」，
            // 这里用 EnumDesktopWindows(默认桌面) 近似。
            onUser = EnumerateDesktop(userDesk, 40, 40);
            bool leaked = onUser.Exists(w => w.Pid == pi.dwProcessId);
            Emit(!leaked, "not-visible-on-user-desktop", J("pid", pi.dwProcessId));

            // 等窗口出现
            string diag;
            Win win = WaitWindow(desk, before, timeoutMs, pi.hProcess, out diag);
            Emit(win != null, "window-found",
                J("hwnd", win == null ? "0x0" : "0x" + win.Hwnd.ToInt64().ToString("x")),
                J("title", win == null ? "" : win.Title),
                J("cls", win == null ? "" : win.Cls),
                J("w", win == null ? 0 : win.W),
                J("h", win == null ? 0 : win.H),
                J("diag", diag ?? ""));
            if (win == null)
            {
                TerminateProcess(pi.hProcess, 0);
                Emit(false, "abort", J("reason", "no window appeared on the new desktop"));
                return 1;
            }

            // 采集：后台桌面上的窗口能不能拿到像素？
            Shot s1 = Grab(win.Hwnd, win.W, win.H);
            Emit(s1.Ok && s1.NonBlack > 0.02, "capture-background-desktop",
                J("printWindowOk", s1.Ok),
                J("nonBlack", Math.Round(s1.NonBlack, 4)),
                J("mean", Math.Round(s1.Mean, 2)),
                J("bytes", s1.Bytes),
                J("ms", Math.Round(s1.Ms, 1)),
                J("hash", s1.Hash));

            Thread.Sleep(700);

            // 稳定性：连采两帧，判断静态还是动态
            Shot s2 = Grab(win.Hwnd, win.W, win.H);
            Emit(true, "stable-check",
                J("same", s2.Hash == s1.Hash),
                J("nonBlack2", Math.Round(s2.NonBlack, 4)));

            // 后台注入：点击窗口中心，看画面变不变。
            // 关键：PostMessage 必须在「目标窗口所在桌面」的线程上发，跨桌面投递会被静默丢弃
            // （主线程仍在用户桌面，所以前面的 PostMessage 全部无效）。
            int cx = win.W / 2, cy = win.H / 2;
            bool pmOk = false;
            RunOnDesktop(desk, delegate
            {
                bool a = PostMessageW(win.Hwnd, WM_MOUSEMOVE, IntPtr.Zero, MakeLParam(cx, cy));
                Thread.Sleep(40);
                bool b = PostMessageW(win.Hwnd, WM_LBUTTONDOWN, (IntPtr)1, MakeLParam(cx, cy));
                Thread.Sleep(30);
                bool c = PostMessageW(win.Hwnd, WM_LBUTTONUP, IntPtr.Zero, MakeLParam(cx, cy));
                pmOk = a && b && c;
            });
            Thread.Sleep(500);
            Shot s3 = Grab(win.Hwnd, win.W, win.H);
            Emit(true, "postmessage-click",
                J("postOk", pmOk),
                J("changed", s3.Hash != s2.Hash),
                J("at", cx + "," + cy),
                J("hashBefore", s2.Hash),
                J("hashAfter", s3.Hash));

            // 后台文字
            bool txOk = false;
            RunOnDesktop(desk, delegate
            {
                bool all = true;
                foreach (char ch in "hello")
                {
                    all &= PostMessageW(win.Hwnd, WM_CHAR, (IntPtr)ch, (IntPtr)1);
                    Thread.Sleep(30);
                }
                txOk = all;
            });
            Thread.Sleep(500);
            Shot s4 = Grab(win.Hwnd, win.W, win.H);
            Emit(true, "postmessage-text",
                J("postOk", txOk),
                J("changed", s4.Hash != s3.Hash),
                J("hashBefore", s3.Hash),
                J("hashAfter", s4.Hash));

            // 关键实验：在「私有桌面」的线程上直接 SendInput / SetCursorPos，
            // 打的是这个桌面的光标队列，还是用户桌面的？这决定「独立鼠标」能不能成立。
            POINT userCurBefore; GetCursorPos(out userCurBefore);
            IntPtr userFgBefore = GetForegroundWindow();
            Shot s5before = Grab(win.Hwnd, win.W, win.H);

            bool sendOk = false;
            bool cursorOnDesk = false;
            int deskCursorX = 0, deskCursorY = 0;
            uint sentCount = 0;
            int cursorErr = 0, sendErr = 0;
            RunOnDesktop(desk, delegate
            {
                // 在这个桌面里，光标应该从 (0,0) 附近开始，和用户桌面的位置互不影响。
                cursorOnDesk = SetCursorPos(120, 90);
                cursorErr = Marshal.GetLastWin32Error();
                POINT p; GetCursorPos(out p);
                deskCursorX = p.X; deskCursorY = p.Y;

                // 在窗口客户区 (cx,cy) 处发一次真实左键点击（绝对坐标，落到这个桌面的虚拟屏上）
                int cw = win.W, chh = win.H;
                RECT wr; GetWindowRect(win.Hwnd, out wr);
                int sx = wr.Left + 40 + (cx - 40);
                int sy = wr.Top + 40 + (cy - 40);
                double fx = (double)sx / Math.Max(1, GetSystemMetrics(SM_CXSCREEN));
                double fy = (double)sy / Math.Max(1, GetSystemMetrics(SM_CYSCREEN));
                INPUT[] batch = new INPUT[3];
                for (int i = 0; i < 3; i++) { batch[i] = new INPUT(); batch[i].type = 0; }
                batch[0].u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
                batch[0].u.mi.dx = (int)(fx * 65535); batch[0].u.mi.dy = (int)(fy * 65535);
                batch[1].u.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
                batch[2].u.mi.dwFlags = MOUSEEVENTF_LEFTUP;
                uint sent = SendInput(3, batch, Marshal.SizeOf(typeof(INPUT)));
                sendErr = Marshal.GetLastWin32Error();
                sentCount = sent;
                sendOk = sent == 3;
            });
            Thread.Sleep(500);
            Shot s5after = Grab(win.Hwnd, win.W, win.H);

            POINT userCurAfter; GetCursorPos(out userCurAfter);
            IntPtr userFgAfter2 = GetForegroundWindow();

            Emit(sendOk, "sendinput-on-private-desktop",
                J("sent", (int)sentCount),
                J("sendErr", sendErr),
                J("cursorErr", cursorErr),
                J("cursorInDesktop", cursorOnDesk ? (deskCursorX + "," + deskCursorY) : "n/a"),
                J("changed", s5before.Hash != s5after.Hash),
                J("hashBefore", s5before.Hash),
                J("hashAfter", s5after.Hash),
                J("cursorInDesktop", cursorOnDesk ? (deskCursorX + "," + deskCursorY) : "n/a"),
                J("userCursorBefore", userCurBefore.X + "," + userCurBefore.Y),
                J("userCursorAfter", userCurAfter.X + "," + userCurAfter.Y),
                J("userCursorUntouched", userCurBefore.X == userCurAfter.X && userCurBefore.Y == userCurAfter.Y),
                J("userForegroundUntouched", userFgBefore == userFgAfter2));

            // 决定性实验二：如果把这个私有桌面切成「当前输入桌面」，
            // SendInput 是否就能打进去了？（= 用户点「接管」时的能力）
            bool takeoverOk = false;
            int takeoverErr = 0;
            bool restored = false;
            if (allowSwitch)
            {
                IntPtr back = input;
                // 安全网：无论主流程出什么岔子，2.5s 后一定把用户切回原桌面。
                // 如果切不回来，用户会看不见自己的桌面——这是不可接受的失败模式。
                Thread guard = new Thread(() =>
                {
                    Thread.Sleep(2500);
                    if (back != IntPtr.Zero) SwitchDesktop(back);
                });
                guard.IsBackground = true;
                guard.Start();

                // SwitchDesktop 只换「系统输入桌面」，不换「本线程绑定的桌面」。
                // SendInput 投递到「本线程绑定的桌面」，所以必须同时 SetThreadDesktop。
                // 而 SetThreadDesktop 只能在还没建过窗口/钩子的线程上调用
                // -> 单开一个线程，在里面一次做完 switch + bind + send。
                bool sw1 = false;
                int swErr = 0, bindErr = 0;
                Thread worker = new Thread(() =>
                {
                    if (input != IntPtr.Zero) { /* 记录原桌面，稍后切回 */ }
                    sw1 = SwitchDesktop(desk);
                    swErr = sw1 ? 0 : Marshal.GetLastWin32Error();
                    if (!sw1) return;
                    Thread.Sleep(300);
                    if (!SetThreadDesktop(desk)) { bindErr = Marshal.GetLastWin32Error(); return; }
                    Thread.Sleep(200);

                    INPUT[] batch2 = new INPUT[3];
                    for (int i = 0; i < 3; i++) { batch2[i] = new INPUT(); batch2[i].type = 0; }
                    int cw = win.W, chh = win.H;
                    RECT wr2; GetWindowRect(win.Hwnd, out wr2);
                    double fx2 = (double)(wr2.Left + cw / 2) / Math.Max(1, GetSystemMetrics(SM_CXSCREEN));
                    double fy2 = (double)(wr2.Top + chh / 2) / Math.Max(1, GetSystemMetrics(SM_CYSCREEN));
                    batch2[0].u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
                    batch2[0].u.mi.dx = (int)(fx2 * 65535); batch2[0].u.mi.dy = (int)(fy2 * 65535);
                    batch2[1].u.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
                    batch2[2].u.mi.dwFlags = MOUSEEVENTF_LEFTUP;
                    uint sent2 = SendInput(3, batch2, Marshal.SizeOf(typeof(INPUT)));
                    takeoverErr = Marshal.GetLastWin32Error();
                    takeoverOk = sent2 == 3;
                });
                worker.IsBackground = true;
                worker.Start();
                worker.Join();

                if (sw1)
                {
                    Thread.Sleep(400);
                    restored = SwitchDesktop(back);
                    Emit(restored, "switch-back", J("win32Error", restored ? 0 : Marshal.GetLastWin32Error()));
                }
                Emit(takeoverOk, "takeover-sendinput",
                    J("switchOk", sw1),
                    J("switchErr", swErr),
                    J("bindErr", bindErr),
                    J("sendErr", takeoverErr));
            }
            else
            {
                Emit(true, "takeover-sendinput", J("skipped", true));
            }

            // 决定性实验三：能不能抓到「整个私有桌面的画面」（含桌面背景/任务栏），
            // 而不只是某一个窗口的 PrintWindow？这才是「复制一个桌面给我看」的关键。
            int deskW = GetSystemMetrics(SM_CXSCREEN), deskH = GetSystemMetrics(SM_CYSCREEN);
            double deskNonBlack = 0; long deskBytes = 0; double deskMs = 0; string deskHash = "";
            int deskCapOk = 0;
            RunOnDesktop(desk, delegate
            {
                IntPtr screen = GetDC(IntPtr.Zero);
                IntPtr mem = CreateCompatibleDC(screen);
                BITMAPINFO bmi = new BITMAPINFO();
                bmi.h.biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER));
                bmi.h.biWidth = deskW; bmi.h.biHeight = -deskH;
                bmi.h.biPlanes = 1; bmi.h.biBitCount = 32;
                IntPtr bits;
                IntPtr dib = CreateDIBSection(mem, ref bmi, 0, out bits, IntPtr.Zero, 0);
                if (dib == IntPtr.Zero) { DeleteDC(mem); ReleaseDC(IntPtr.Zero, screen); return; }
                IntPtr old = SelectObject(mem, dib);
                for (int i = 0; i < deskW * deskH * 4; i += 4) Marshal.WriteInt32(bits, i, 0);
                Stopwatch sw = Stopwatch.StartNew();
                bool ok = BitBlt(mem, 0, 0, deskW, deskH, screen, 0, 0, 0x00CC0020);
                sw.Stop();
                deskMs = sw.Elapsed.TotalMilliseconds;
                deskCapOk = ok ? 1 : 0;
                int total = deskW * deskH * 4;
                byte[] data = new byte[total];
                Marshal.Copy(bits, data, 0, total);
                int lit = 0, samples = 0;
                uint hash = 2166136261u;
                for (int y = 0; y < deskH; y += 4)
                    for (int x = 0; x < deskW; x += 4)
                    {
                        int i = (y * deskW + x) * 4;
                        int lum = (data[i + 2] * 299 + data[i + 1] * 587 + data[i] * 114) / 1000;
                        samples++; if (lum > 10) lit++;
                        hash = (hash ^ (uint)lum) * 16777619u;
                    }
                deskNonBlack = samples == 0 ? 0 : (double)lit / samples;
                deskBytes = total;
                deskHash = hash.ToString("x8");
                SelectObject(mem, old); DeleteObject(dib); DeleteDC(mem); ReleaseDC(IntPtr.Zero, screen);
            });
            Emit(deskNonBlack > 0.02, "capture-desktop-surface",
                J("bitbltOk", deskCapOk == 1),
                J("w", deskW), J("h", deskH),
                J("nonBlack", Math.Round(deskNonBlack, 4)),
                J("bytes", deskBytes),
                J("ms", Math.Round(deskMs, 1)),
                J("hash", deskHash));

            // 用户的桌面有没有被碰过
            IntPtr fgAfter = GetForegroundWindow();
            POINT curAfter; GetCursorPos(out curAfter);
            Emit(fgBefore == fgAfter, "user-foreground-untouched",
                J("before", "0x" + fgBefore.ToInt64().ToString("x")),
                J("after", "0x" + fgAfter.ToInt64().ToString("x")));
            Emit(curBefore.X == curAfter.X && curBefore.Y == curAfter.Y, "user-cursor-untouched",
                J("before", curBefore.X + "," + curBefore.Y),
                J("after", curAfter.X + "," + curAfter.Y));

            // 能不能把用户切到这个桌面看（可选能力：切过去会让用户离开自己的桌面）
            if (allowSwitch)
            {
                bool switched = SwitchDesktop(desk);
                Emit(switched, "switch-desktop",
                    J("win32Error", switched ? 0 : Marshal.GetLastWin32Error()));
                Thread.Sleep(300);
                if (switched)
                {
                    Emit(true, "switched-back", J("ok", SwitchDesktop(input != IntPtr.Zero ? input : IntPtr.Zero)));
                }
            }
            else
            {
                Emit(true, "switch-desktop", J("skipped", true));
            }

            PostMessageW(win.Hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            WaitForSingleObject(pi.hProcess, 3000);
            TerminateProcess(pi.hProcess, 0);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            Emit(true, "done");
            return 0;
        }
        finally
        {
            CloseDesktopSafe(desk);
        }
    }
}
