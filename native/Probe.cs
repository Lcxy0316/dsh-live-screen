// Probe.cs — 采集/注入能力实测工具（v2 架构的前置证据采集）
// 用途：对任意顶层窗口测量 PrintWindow 黑图率与耗时，以及 PostMessage 后台点击是否真的生效。
// 编译：scripts\build-native.ps1（csc.exe，.NET Framework 4.8，C# 5 语法）
// 用法：
//   Probe.exe --list
//   Probe.exe --capture [--hwnd 0x1a2b | --all] [--out file.jsonl]
//   Probe.exe --click <hwndHex> <x> <y>
//   Probe.exe --move  <hwndHex> <x> <y>

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Probe
{
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFOHEADER
    {
        public int biSize;
        public int biWidth;
        public int biHeight;
        public short biPlanes;
        public short biBitCount;
        public int biCompression;
        public int biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public int biClrUsed;
        public int biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct BITMAPINFO { public BITMAPINFOHEADER bmiHeader; public int bmiColors; }

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
    [DllImport("user32.dll")] static extern IntPtr GetWindowDC(IntPtr h);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFO bmi, uint usage, out IntPtr bits, IntPtr hSection, uint offset);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);

    const uint PW_RENDERFULLCONTENT = 0x2;
    const uint WM_MOUSEMOVE = 0x0200;
    const uint WM_LBUTTONDOWN = 0x0201;
    const uint WM_LBUTTONUP = 0x0202;
    const uint WM_CLOSE = 0x0010;

    static string Hex(long v) { return "0x" + v.ToString("x"); }

    static string Esc(string s)
    {
        if (s == null) return "";
        var sb = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') { sb.Append('\\'); sb.Append(c); }
            else if (c < 0x20) { sb.Append("\\u"); sb.Append(((int)c).ToString("x4")); }
            else sb.Append(c);
        }
        return sb.ToString();
    }

    class Win
    {
        public IntPtr Hwnd;
        public string Title = "";
        public string Cls = "";
        public uint Pid;
        public int W, H;
        public bool Minimized;
        public bool Cloaked;
    }

    static List<Win> Enumerate()
    {
        var list = new List<Win>();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            int len = GetWindowTextLengthW(h);
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            int w = r.Right - r.Left, hh = r.Bottom - r.Top;
            if (w < 160 || hh < 120) return true;

            var sb = new StringBuilder(Math.Max(len + 1, 8));
            GetWindowTextW(h, sb, sb.Capacity);
            var cls = new StringBuilder(256);
            GetClassNameW(h, cls, cls.Capacity);
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            int cloaked = 0;
            try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }

            var win = new Win();
            win.Hwnd = h;
            win.Title = sb.ToString();
            win.Cls = cls.ToString();
            win.Pid = pid;
            win.W = w;
            win.H = hh;
            win.Minimized = IsIconic(h);
            win.Cloaked = cloaked != 0;
            list.Add(win);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    // ── 单窗口抓取 ────────────────────────────────────────────────────────────
    class Shot
    {
        public bool Ok;
        public double Ms;
        public double NonBlack;   // 亮度 > 10 的采样点占比
        public double Mean;       // 平均亮度
        public int Tiles;
        public string Hash;
        public int W, H;
    }

    static Shot Grab(IntPtr hwnd, int w, int h, uint flags)
    {
        var shot = new Shot();
        shot.W = w; shot.H = h;
        if (w <= 0 || h <= 0) return shot;

        IntPtr screenDc = GetWindowDC(IntPtr.Zero);
        IntPtr memDc = CreateCompatibleDC(screenDc);
        var bmi = new BITMAPINFO();
        bmi.bmiHeader.biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER));
        bmi.bmiHeader.biWidth = w;
        bmi.bmiHeader.biHeight = -h;   // top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = 0;
        IntPtr bits;
        IntPtr dib = CreateDIBSection(memDc, ref bmi, 0, out bits, IntPtr.Zero, 0);
        if (dib == IntPtr.Zero) { DeleteDC(memDc); ReleaseDC(IntPtr.Zero, screenDc); return shot; }
        IntPtr old = SelectObject(memDc, dib);

        // 清零，便于识别「PrintWindow 没写任何东西」
        for (int i = 0; i < w * h; i++) Marshal.WriteInt32(bits, i * 4, 0);

        var sw = System.Diagnostics.Stopwatch.StartNew();
        shot.Ok = PrintWindow(hwnd, memDc, flags);
        sw.Stop();
        shot.Ms = sw.Elapsed.TotalMilliseconds;

        int stride = w * 4;
        var buf = new byte[stride * h];
        Marshal.Copy(bits, buf, 0, buf.Length);

        // 亮度采样（每 4 像素取 1）
        long lit = 0, total = 0, sum = 0;
        for (int y = 0; y < h; y += 2)
        {
            int row = y * stride;
            for (int x = 0; x < w; x += 2)
            {
                int o = row + x * 4;
                int b = buf[o], g = buf[o + 1], r = buf[o + 2];
                int lum = (r * 299 + g * 587 + b * 114) / 1000;
                sum += lum; total++;
                if (lum > 10) lit++;
            }
        }
        shot.NonBlack = total == 0 ? 0 : (double)lit / total;
        shot.Mean = total == 0 ? 0 : (double)sum / total;

        // 16x16 分块 FNV-1a 哈希
        const int COLS = 16, ROWS = 16;
        shot.Tiles = COLS * ROWS;
        var hashes = new uint[COLS * ROWS];
        for (int ty = 0; ty < ROWS; ty++)
        {
            int y0 = (int)((long)h * ty / ROWS), y1 = (int)((long)h * (ty + 1) / ROWS);
            for (int tx = 0; tx < COLS; tx++)
            {
                int x0 = (int)((long)w * tx / COLS), x1 = (int)((long)w * (tx + 1) / COLS);
                uint hsh = 2166136261u;
                for (int y = y0; y < y1; y += 3)
                {
                    int row = y * stride;
                    for (int x = x0; x < x1; x += 3)
                    {
                        int o = row + x * 4;
                        hsh = (hsh ^ buf[o]) * 16777619u;
                        hsh = (hsh ^ buf[o + 1]) * 16777619u;
                        hsh = (hsh ^ buf[o + 2]) * 16777619u;
                    }
                }
                hashes[ty * COLS + tx] = hsh;
            }
        }
        var hb = new StringBuilder(hashes.Length * 8);
        foreach (uint v in hashes) hb.Append(v.ToString("x8"));
        shot.Hash = hb.ToString();

        SelectObject(memDc, old);
        DeleteObject(dib);
        DeleteDC(memDc);
        ReleaseDC(IntPtr.Zero, screenDc);
        return shot;
    }

    static int TileDelta(string a, string b)
    {
        if (a == null || b == null) return -1;
        if (a.Length != b.Length) return -1;
        int diff = 0;
        for (int i = 0; i + 8 <= a.Length; i += 8)
            if (string.CompareOrdinal(a, i, b, i, 8) != 0) diff++;
        return diff;
    }

    static IntPtr MakeLParam(int x, int y)
    {
        return (IntPtr)((y << 16) | (x & 0xFFFF));
    }

    // 等某个 pid 名下出现一个够大的可见窗口
    static Win WaitWindow(uint pid, int timeoutMs)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            foreach (var w in Enumerate())
            {
                if (w.Pid == pid && !w.Cloaked && w.W >= 160 && w.H >= 120) return w;
            }
            Thread.Sleep(250);
        }
        return null;
    }

    // 等一个「启动前不存在」的新窗口：UWP/壳进程会换 pid，只能按新增窗口识别
    static Win WaitNewWindow(HashSet<IntPtr> before, int timeoutMs)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            var best = (Win)null;
            foreach (var w in Enumerate())
            {
                if (before.Contains(w.Hwnd)) continue;
                if (w.Cloaked) continue;
                if (w.W < 160 || w.H < 120) continue;
                if (w.Minimized) continue;
                // 优先取面积最大的新窗口（避免抓到 tooltip / 输入法候选）
                if (best == null || (long)w.W * w.H > (long)best.W * best.H) best = w;
            }
            if (best != null) return best;
            Thread.Sleep(250);
        }
        return null;
    }

    // ── 批量实测：launch → 等窗口 → PrintWindow 量测 → PostMessage 探测 → 关窗 ──
    static string SuiteOne(string label, string exe, string args)
    {
        var sb = new StringBuilder();
        sb.Append("{\"label\":\"" + Esc(label) + "\"");
        sb.Append(",\"exe\":\"" + Esc(exe) + "\"");

        System.Diagnostics.Process proc = null;
        var preWins = new HashSet<IntPtr>();
        foreach (var w in Enumerate()) preWins.Add(w.Hwnd);
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo(exe);
            if (!string.IsNullOrEmpty(args)) psi.Arguments = args;
            psi.UseShellExecute = true;
            proc = System.Diagnostics.Process.Start(psi);
        }
        catch (Exception ex)
        {
            sb.Append(",\"error\":\"" + Esc(ex.Message) + "\"}");
            return sb.ToString();
        }

        uint pid = (uint)proc.Id;
        sb.Append(",\"pid\":" + pid);

        var win = WaitNewWindow(preWins, 15000);
        bool reused = false;
        if (win == null)
        {
            // 应用已在运行（单实例）→ 复用它的既有窗口，宁可测「已有实例」也不要空手
            string stem = Path.GetFileNameWithoutExtension(exe);
            foreach (var w in Enumerate())
            {
                if (w.Cloaked || w.Minimized) continue;
                if (w.W < 160 || w.H < 120) continue;
                string pname = "";
                try { pname = System.Diagnostics.Process.GetProcessById((int)w.Pid).ProcessName; } catch { }
                if (string.Equals(pname, stem, StringComparison.OrdinalIgnoreCase))
                {
                    if (win == null || (long)w.W * w.H > (long)win.W * win.H) win = w;
                }
            }
            if (win != null) reused = true;
        }
        if (win == null)
        {
            sb.Append(",\"error\":\"no-window\"}");
            try { proc.Kill(); } catch { }
            return sb.ToString();
        }
        sb.Append(",\"reused\":" + (reused ? "true" : "false"));

        sb.Append(",\"hwnd\":\"" + Hex(win.Hwnd.ToInt64()) + "\"");
        sb.Append(",\"title\":\"" + Esc(win.Title) + "\"");
        sb.Append(",\"cls\":\"" + Esc(win.Cls) + "\"");
        sb.Append(",\"w\":" + win.W + ",\"h\":" + win.H);

        Thread.Sleep(900);   // 让首帧渲染完成

        var a = Grab(win.Hwnd, win.W, win.H, PW_RENDERFULLCONTENT);
        var b = Grab(win.Hwnd, win.W, win.H, PW_RENDERFULLCONTENT);
        var c = Grab(win.Hwnd, win.W, win.H, 0);

        sb.Append(",\"full_ok\":" + (a.Ok ? "true" : "false"));
        sb.Append(",\"full_ms\":" + a.Ms.ToString("F1", CultureInfo.InvariantCulture));
        sb.Append(",\"full_ms2\":" + b.Ms.ToString("F1", CultureInfo.InvariantCulture));
        sb.Append(",\"full_nonblack\":" + a.NonBlack.ToString("F4", CultureInfo.InvariantCulture));
        sb.Append(",\"full_mean\":" + a.Mean.ToString("F1", CultureInfo.InvariantCulture));
        sb.Append(",\"stable\":" + (TileDelta(a.Hash, b.Hash) == 0 ? "true" : "false"));
        sb.Append(",\"plain_nonblack\":" + c.NonBlack.ToString("F4", CultureInfo.InvariantCulture));
        sb.Append(",\"black\":" + (a.NonBlack < 0.02 ? "true" : "false"));

        // 后台点击探测：客户区中心 + 左上 1/4 点各点一下，看分块是否变化
        var pre0 = Grab(win.Hwnd, win.W, win.H, PW_RENDERFULLCONTENT);
        int hitA = PostClick(win.Hwnd, win.W / 2, win.H / 2);
        Thread.Sleep(300);
        var d1 = Grab(win.Hwnd, win.W, win.H, PW_RENDERFULLCONTENT);
        int deltaA = TileDelta(pre0.Hash, d1.Hash);
        int hitB = PostClick(win.Hwnd, win.W / 4, win.H / 4);
        Thread.Sleep(300);
        var d2 = Grab(win.Hwnd, win.W, win.H, PW_RENDERFULLCONTENT);
        int deltaB = TileDelta(d1.Hash, d2.Hash);

        sb.Append(",\"pm_center_delta\":" + deltaA);
        sb.Append(",\"pm_center_ok\":" + (hitA > 0 ? "true" : "false"));
        sb.Append(",\"pm_center_changed\":" + (deltaA > 0 ? "true" : "false"));
        sb.Append(",\"pm_corner_ok\":" + (hitB > 0 ? "true" : "false"));
        sb.Append(",\"pm_corner_changed\":" + (deltaB > 0 ? "true" : "false"));

        // 键盘探测：WM_CHAR 'X'
        var before = Grab(win.Hwnd, win.W, win.H, PW_RENDERFULLCONTENT);
        PostMessage(win.Hwnd, 0x0102 /*WM_CHAR*/, (IntPtr)'X', (IntPtr)1);
        Thread.Sleep(280);
        var after = Grab(win.Hwnd, win.W, win.H, PW_RENDERFULLCONTENT);
        sb.Append(",\"wm_char_delta\":" + TileDelta(before.Hash, after.Hash));

        // 关窗：先 WM_CLOSE，超时 kill（复用别人窗口时不关，避免误杀用户手上的应用）
        if (reused)
        {
            sb.Append(",\"closed\":false");
            sb.AppendLine("}");
            return sb.ToString();
        }
        PostMessage(win.Hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        bool done = false;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < 4000)
        {
            if (proc.HasExited) { done = true; break; }
            try { proc.Refresh(); } catch { }
            bool stillThere = false;
            foreach (var w in Enumerate()) if (w.Hwnd == win.Hwnd) { stillThere = true; break; }
            if (!stillThere) { done = true; break; }
            Thread.Sleep(200);
        }
        if (!done) { try { proc.Kill(); } catch { } }
        sb.Append(",\"closed\":" + (done ? "true" : "false"));
        sb.AppendLine("}");
        return sb.ToString();
    }

    static int PostClick(IntPtr hwnd, int x, int y)
    {
        IntPtr lp = MakeLParam(x, y);
        bool a = PostMessage(hwnd, WM_MOUSEMOVE, IntPtr.Zero, lp);
        Thread.Sleep(50);
        bool b = PostMessage(hwnd, WM_LBUTTONDOWN, (IntPtr)1, lp);
        Thread.Sleep(40);
        bool c = PostMessage(hwnd, WM_LBUTTONUP, IntPtr.Zero, lp);
        int posted = (a ? 1 : 0) + (b ? 1 : 0) + (c ? 1 : 0);
        return posted;
    }

    static int Main(string[] args)
    {
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }

        string mode = args.Length > 0 ? args[0] : "--list";
        string outPath = null;
        for (int i = 0; i < args.Length - 1; i++) if (args[i] == "--out") outPath = args[i + 1];

        var sb = new StringBuilder();
        var stdout = Console.Out;
        if (outPath != null) { try { sb = new StringBuilder(); } catch { } }

        if (mode == "--list")
        {
            var wins = Enumerate();
            foreach (var w in wins)
            {
                sb.Append("{\"hwnd\":\"" + Hex(w.Hwnd.ToInt64()) + "\"");
                sb.Append(",\"title\":\"" + Esc(w.Title) + "\"");
                sb.Append(",\"cls\":\"" + Esc(w.Cls) + "\"");
                sb.Append(",\"pid\":" + w.Pid);
                sb.Append(",\"w\":" + w.W + ",\"h\":" + w.H);
                sb.Append(",\"minimized\":" + (w.Minimized ? "true" : "false"));
                sb.Append(",\"cloaked\":" + (w.Cloaked ? "true" : "false"));
                sb.AppendLine("}");
            }
        }
        else if (mode == "--capture")
        {
            string only = null;
            for (int i = 0; i < args.Length - 1; i++) if (args[i] == "--hwnd") only = args[i + 1];
            var wins = Enumerate();
            foreach (var w in wins)
            {
                if (only != null)
                {
                    long want;
                    if (!long.TryParse(only.Replace("0x", ""), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out want)) continue;
                    if (w.Hwnd.ToInt64() != want) continue;
                }
                var full = Grab(w.Hwnd, w.W, w.H, PW_RENDERFULLCONTENT);
                var plain = Grab(w.Hwnd, w.W, w.H, 0);
                sb.Append("{\"hwnd\":\"" + Hex(w.Hwnd.ToInt64()) + "\"");
                sb.Append(",\"title\":\"" + Esc(w.Title) + "\"");
                sb.Append(",\"cls\":\"" + Esc(w.Cls) + "\"");
                sb.Append(",\"pid\":" + w.Pid);
                sb.Append(",\"w\":" + w.W + ",\"h\":" + w.H);
                sb.Append(",\"minimized\":" + (w.Minimized ? "true" : "false"));
                sb.Append(",\"cloaked\":" + (w.Cloaked ? "true" : "false"));
                sb.Append(",\"full_ok\":" + (full.Ok ? "true" : "false"));
                sb.Append(",\"full_ms\":" + full.Ms.ToString("F1", CultureInfo.InvariantCulture));
                sb.Append(",\"full_nonblack\":" + full.NonBlack.ToString("F4", CultureInfo.InvariantCulture));
                sb.Append(",\"full_mean\":" + full.Mean.ToString("F1", CultureInfo.InvariantCulture));
                sb.Append(",\"plain_ok\":" + (plain.Ok ? "true" : "false"));
                sb.Append(",\"plain_ms\":" + plain.Ms.ToString("F1", CultureInfo.InvariantCulture));
                sb.Append(",\"plain_nonblack\":" + plain.NonBlack.ToString("F4", CultureInfo.InvariantCulture));
                sb.Append(",\"plain_mean\":" + plain.Mean.ToString("F1", CultureInfo.InvariantCulture));
                sb.AppendLine("}");
            }
        }
        else if (mode == "--click" || mode == "--move")
        {
            long h;
            if (args.Length < 4 || !long.TryParse(args[1].Replace("0x", ""), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out h))
            {
                Console.Error.WriteLine("usage: --click <hwndHex> <x> <y>");
                return 2;
            }
            IntPtr hwnd = (IntPtr)h;
            int x = int.Parse(args[2]), y = int.Parse(args[3]);
            var wins = Enumerate();
            Win target = null;
            foreach (var w in wins) if (w.Hwnd == hwnd) target = w;
            int ww = target != null ? target.W : 800, hh = target != null ? target.H : 600;

            var before = Grab(hwnd, ww, hh, PW_RENDERFULLCONTENT);
            IntPtr lp = MakeLParam(x, y);
            bool m1 = PostMessage(hwnd, WM_MOUSEMOVE, IntPtr.Zero, lp);
            Thread.Sleep(80);
            bool m2 = PostMessage(hwnd, WM_LBUTTONDOWN, (IntPtr)1, lp);
            Thread.Sleep(40);
            bool m3 = PostMessage(hwnd, WM_LBUTTONUP, IntPtr.Zero, lp);
            Thread.Sleep(220);
            var after = Grab(hwnd, ww, hh, PW_RENDERFULLCONTENT);
            int delta = TileDelta(before.Hash, after.Hash);

            sb.Append("{\"hwnd\":\"" + Hex(h) + "\"");
            sb.Append(",\"x\":" + x + ",\"y\":" + y);
            sb.Append(",\"post_move\":" + (m1 ? "true" : "false"));
            sb.Append(",\"post_down\":" + (m2 ? "true" : "false"));
            sb.Append(",\"post_up\":" + (m3 ? "true" : "false"));
            sb.Append(",\"tile_delta\":" + delta);
            sb.Append(",\"before_nonblack\":" + before.NonBlack.ToString("F4", CultureInfo.InvariantCulture));
            sb.Append(",\"after_nonblack\":" + after.NonBlack.ToString("F4", CultureInfo.InvariantCulture));
            sb.Append(",\"changed\":" + (delta > 0 ? "true" : "false"));
            sb.AppendLine("}");
        }
        else if (mode == "--suite")
        {
            string[] labels = {
                "notepad", "calc", "explorer", "charmap", "control", "mstsc",
                "edge", "vscode", "douyin", "qq", "wmplayer", "steam"
            };
            string[] exes = {
                @"C:\Windows\System32\notepad.exe",
                @"C:\Windows\System32\calc.exe",
                @"C:\Windows\explorer.exe",
                @"C:\Windows\System32\charmap.exe",
                @"C:\Windows\System32\control.exe",
                @"C:\Windows\System32\mstsc.exe",
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"C:\Users\7\AppData\Local\Programs\Microsoft VS Code\Code.exe",
                @"C:\Program Files (x86)\ByteDance\douyin\douyin.exe",
                @"C:\Program Files\Tencent\QQNT\QQ.exe",
                @"C:\Program Files\Windows Media Player\wmplayer.exe",
                @"C:\Program Files (x86)\Steam\steam.exe"
            };
            string[] argv = {
                "", "",
                @"C:\Users\7\Doubao\chats\2026-11-12\new-chat-1",
                "", "", "",
                "about:blank --new-window",
                "", "", "", "", ""
            };
            for (int i = 0; i < labels.Length; i++)
            {
                if (!File.Exists(exes[i]))
                {
                    sb.Append("{\"label\":\"" + Esc(labels[i]) + "\",\"exe\":\"" + Esc(exes[i]) + "\",\"error\":\"not-installed\"}");
                    sb.AppendLine();
                    continue;
                }
                string row = SuiteOne(labels[i], exes[i], argv[i]).TrimEnd();
                sb.AppendLine(row);
                Console.Error.WriteLine("[suite] " + labels[i] + " done");
                Thread.Sleep(600);
            }
        }
        else
        {
            Console.Error.WriteLine("unknown mode " + mode);
            return 2;
        }

        string text = sb.ToString();
        if (outPath != null) File.WriteAllText(outPath, text, Encoding.UTF8);
        stdout.Write(text);
        stdout.Flush();
        return 0;
    }
}
