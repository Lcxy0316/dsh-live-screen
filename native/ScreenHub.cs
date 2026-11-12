using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class N
{
    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAPINFOHEADER
    {
        public uint biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public uint biCompression;
        public uint biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public uint biClrUsed;
        public uint biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAPINFO
    {
        public BITMAPINFOHEADER h;
        public uint colors;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFO bmi, uint usage, out IntPtr bits, IntPtr hSection, uint offset);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);

    public const uint SRCCOPY = 0x00CC0020;
    public const uint CAPTUREBLT = 0x40000000;
    [DllImport("gdi32.dll")] public static extern bool StretchBlt(IntPtr dst,int dx,int dy,int dw,int dh,IntPtr src,int sx,int sy,int sw,int sh,uint rop);
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;
}

sealed class Capturer : IDisposable
{
    public int Width;
    public int Height;
    private IntPtr _screenDc;
    private IntPtr _memDc;
    private IntPtr _dib;
    private IntPtr _old;
    public IntPtr Bits;
    private int _stride;

    public Capturer(int w, int h)
    {
        Width = w;
        Height = h;
        _screenDc = N.GetDC(IntPtr.Zero);
        _memDc = N.CreateCompatibleDC(_screenDc);
        var bmi = new N.BITMAPINFO();
        bmi.h.biSize = (uint)Marshal.SizeOf(typeof(N.BITMAPINFOHEADER));
        bmi.h.biWidth = w;
        bmi.h.biHeight = -h; // top-down
        bmi.h.biPlanes = 1;
        bmi.h.biBitCount = 32;
        bmi.h.biCompression = 0; // BI_RGB
        IntPtr bits;
        _dib = N.CreateDIBSection(_memDc, ref bmi, 0, out bits, IntPtr.Zero, 0);
        if (_dib == IntPtr.Zero) throw new InvalidOperationException("CreateDIBSection failed");
        Bits = bits;
        _old = N.SelectObject(_memDc, _dib);
        _stride = w * 4;
    }

    public bool Grab()
    {
        return N.BitBlt(_memDc, 0, 0, Width, Height, _screenDc, 0, 0, N.SRCCOPY);
    }

    public Bitmap Wrap()
    {
        return new Bitmap(Width, Height, _stride, PixelFormat.Format32bppRgb, Bits);
    }

    public void Dispose()
    {
        if (_old != IntPtr.Zero) N.SelectObject(_memDc, _old);
        if (_dib != IntPtr.Zero) N.DeleteObject(_dib);
        if (_memDc != IntPtr.Zero) N.DeleteDC(_memDc);
        if (_screenDc != IntPtr.Zero) N.ReleaseDC(IntPtr.Zero, _screenDc);
    }
}

static class Program
{
    static ImageCodecInfo _jpeg;
    static EncoderParameters _encParams;
    static long _quality = 55;

    static void SetQuality(long q)
    {
        _quality = q;
        _jpeg = null;
        foreach (var c in ImageCodecInfo.GetImageEncoders())
            if (c.MimeType == "image/jpeg") { _jpeg = c; break; }
        _encParams = new EncoderParameters(1);
        _encParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, q);
    }

    static int Main(string[] args)
    {
        try { N.SetProcessDpiAwareness(2); } catch { N.SetProcessDPIAware(); }

        string mode = "bench";
        int fps = 12;
        double scale = 1.0;
        long quality = 55;
        int benchFrames = 120;

        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (a == "--mode" && i + 1 < args.Length) mode = args[++i];
            else if (a == "--fps" && i + 1 < args.Length) fps = int.Parse(args[++i]);
            else if (a == "--scale" && i + 1 < args.Length) scale = double.Parse(args[++i], System.Globalization.CultureInfo.InvariantCulture);
            else if (a == "--quality" && i + 1 < args.Length) quality = long.Parse(args[++i]);
            else if (a == "--frames" && i + 1 < args.Length) benchFrames = int.Parse(args[++i]);
        }

        int sw = N.GetSystemMetrics(0);
        int sh = N.GetSystemMetrics(1);
        Console.Error.WriteLine("screen=" + sw + "x" + sh + " mode=" + mode + " scale=" + scale + " q=" + quality + " fps=" + fps);

        SetQuality(quality);

        if (mode == "bench") return Bench(sw, sh, scale, benchFrames, quality);
        return Stream(sw, sh, scale, fps);
    }

    static int Bench(int sw, int sh, double scale, int frames, long q)
    {
        using (var cap = new Capturer(sw, sh))
        {
            int tw = Math.Max(2, (int)Math.Round(sw * scale));
            int th = Math.Max(2, (int)Math.Round(sh * scale));
            bool needScale = tw != sw || th != sh;
            Bitmap scaled = needScale ? new Bitmap(tw, th, PixelFormat.Format32bppRgb) : null;
            Graphics gs = needScale ? Graphics.FromImage(scaled) : null;
            if (gs != null) gs.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;

            var ms = new MemoryStream(1024 * 256);
            // warmup
            for (int i = 0; i < 5; i++) { cap.Grab(); Encode(cap, scaled, gs, ms, q); }

            var swTotal = Stopwatch.StartNew();
            var swCap = new Stopwatch();
            var swEnc = new Stopwatch();
            long bytes = 0;
            long lastSize = 0;
            for (int i = 0; i < frames; i++)
            {
                swCap.Start();
                cap.Grab();
                swCap.Stop();
                swEnc.Start();
                ms.SetLength(0);
                lastSize = Encode(cap, scaled, gs, ms, q);
                swEnc.Stop();
                bytes += lastSize;
            }
            swTotal.Stop();

            double capMs = swCap.Elapsed.TotalMilliseconds / frames;
            double encMs = swEnc.Elapsed.TotalMilliseconds / frames;
            double totalMs = swTotal.Elapsed.TotalMilliseconds / frames;
            var p = Process.GetCurrentProcess();
            Console.Error.WriteLine("RESULT bench");
            Console.Error.WriteLine("frames=" + frames + " out=" + tw + "x" + th);
            Console.Error.WriteLine("capture_ms=" + capMs.ToString("F2"));
            Console.Error.WriteLine("encode_ms=" + encMs.ToString("F2"));
            Console.Error.WriteLine("total_ms=" + totalMs.ToString("F2"));
            Console.Error.WriteLine("fps_ceiling=" + (1000.0 / totalMs).ToString("F1"));
            Console.Error.WriteLine("avg_frame_kb=" + ((bytes / (double)frames) / 1024.0).ToString("F1"));
            Console.Error.WriteLine("last_frame_kb=" + (lastSize / 1024.0).ToString("F1"));
            Console.Error.WriteLine("cpu_ms_per_frame=" + (p.TotalProcessorTime.TotalMilliseconds / frames).ToString("F2"));
            Console.Error.WriteLine("ws_mb=" + (p.WorkingSet64 / 1048576.0).ToString("F1"));
            Console.Error.WriteLine("peak_ws_mb=" + (p.PeakWorkingSet64 / 1048576.0).ToString("F1"));
            Console.Error.WriteLine("private_mb=" + (p.PrivateMemorySize64 / 1048576.0).ToString("F1"));
            Console.Error.WriteLine("threads=" + p.Threads.Count);
            return 0;
        }
    }

    static long Encode(Capturer cap, Bitmap scaled, Graphics gs, MemoryStream ms, long q)
    {
        if (scaled == null)
        {
            using (var bmp = cap.Wrap()) bmp.Save(ms, _jpeg, _encParams);
        }
        else
        {
            using (var bmp = cap.Wrap())
            {
                gs.DrawImage(bmp, 0, 0, scaled.Width, scaled.Height);
            }
            scaled.Save(ms, _jpeg, _encParams);
        }
        return ms.Length;
    }

    static int Stream(int sw, int sh, double scale, int fps)
    {
        var stdout = Console.OpenStandardOutput();
        var stdin = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
        using (var cap = new Capturer(sw, sh))
        {
            int tw = Math.Max(2, (int)Math.Round(sw * scale));
            int th = Math.Max(2, (int)Math.Round(sh * scale));
            bool needScale = tw != sw || th != sh;
            Bitmap scaled = needScale ? new Bitmap(tw, th, PixelFormat.Format32bppRgb) : null;
            Graphics gs = needScale ? Graphics.FromImage(scaled) : null;
            if (gs != null) gs.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;

            var ms = new MemoryStream(1024 * 256);
            var lenBuf = new byte[4];
            var cmdQueue = new List<string>();
            var cmdLock = new object();
            bool running = true;

            var reader = new Thread(delegate ()
            {
                try
                {
                    string line;
                    while ((line = stdin.ReadLine()) != null)
                    {
                        lock (cmdLock) cmdQueue.Add(line);
                    }
                }
                catch { }
                running = false;
            });
            reader.IsBackground = true;
            reader.Start();

            // first frame
            cap.Grab(); ms.SetLength(0); Encode(cap, scaled, gs, ms, _quality);

            // metadata line on stderr for the parent
            Console.Error.WriteLine("READY width=" + tw + " height=" + th + " srcw=" + sw + " srch=" + sh);

            int intervalMs = Math.Max(1, 1000 / Math.Max(1, fps));
            var sw2 = Stopwatch.StartNew();
            long lastTx = sw2.ElapsedMilliseconds;
            int sent = 0;

            while (running)
            {
                // drain commands
                List<string> local;
                lock (cmdLock) { local = new List<string>(cmdQueue); cmdQueue.Clear(); }
                for (int i = 0; i < local.Count; i++)
                {
                    try { HandleCommand(local[i]); } catch (Exception e) { Console.Error.WriteLine("cmderr " + e.Message); }
                    if (local[i].StartsWith("QUIT")) running = false;
                }
                if (!running) break;

                long t0 = sw2.ElapsedMilliseconds;
                cap.Grab();
                ms.SetLength(0);
                long len = Encode(cap, scaled, gs, ms, _quality);

                lenBuf[0] = (byte)(len & 0xFF);
                lenBuf[1] = (byte)((len >> 8) & 0xFF);
                lenBuf[2] = (byte)((len >> 16) & 0xFF);
                lenBuf[3] = (byte)((len >> 24) & 0xFF);
                stdout.Write(lenBuf, 0, 4);
                ms.Position = 0;
                ms.CopyTo(stdout);
                stdout.Flush();
                sent++;

                long spent = sw2.ElapsedMilliseconds - t0;
                int wait = (int)(intervalMs - spent);
                if (wait > 0) Thread.Sleep(wait);
            }
            Console.Error.WriteLine("stream end frames=" + sent);
            return 0;
        }
    }

    static void HandleCommand(string raw)
    {
        string line = raw.Trim();
        if (line.Length == 0) return;
        string[] p = line.Split(' ');
        string op = p[0].ToUpperInvariant();

        switch (op)
        {
            case "MV":
                N.SetCursorPos(int.Parse(p[1]), int.Parse(p[2]));
                break;
            case "CL":
                {
                    int x = int.Parse(p[1]); int y = int.Parse(p[2]);
                    string b = p.Length > 3 ? p[3] : "l";
                    N.SetCursorPos(x, y);
                    Thread.Sleep(12);
                    uint down = b == "r" ? N.MOUSEEVENTF_RIGHTDOWN : (b == "m" ? N.MOUSEEVENTF_MIDDLEDOWN : N.MOUSEEVENTF_LEFTDOWN);
                    uint up = b == "r" ? N.MOUSEEVENTF_RIGHTUP : (b == "m" ? N.MOUSEEVENTF_MIDDLEUP : N.MOUSEEVENTF_LEFTUP);
                    Mouse(down); Thread.Sleep(18); Mouse(up);
                    break;
                }
            case "DN":
                Mouse(p.Length > 1 && p[1] == "r" ? N.MOUSEEVENTF_RIGHTDOWN : N.MOUSEEVENTF_LEFTDOWN);
                break;
            case "UP":
                Mouse(p.Length > 1 && p[1] == "r" ? N.MOUSEEVENTF_RIGHTUP : N.MOUSEEVENTF_LEFTUP);
                break;
            case "SC":
                {
                    int dy = int.Parse(p[1]);
                    var inp = new N.INPUT[1];
                    inp[0].type = N.INPUT_MOUSE;
                    inp[0].u.mi.dwFlags = N.MOUSEEVENTF_WHEEL;
                    inp[0].u.mi.mouseData = (uint)(-dy * 120);
                    N.SendInput(1, inp, Marshal.SizeOf(typeof(N.INPUT)));
                    break;
                }
            case "TX":
                {
                    string text = line.Length > 3 ? line.Substring(3) : "";
                    foreach (char ch in text) TypeChar(ch);
                    break;
                }
            case "KY":
                {
                    int vk = int.Parse(p[1]);
                    bool down = p.Length > 2 && p[2].ToLowerInvariant().StartsWith("d");
                    Key((ushort)vk, down);
                    break;
                }
            case "FOCUS":
                {
                    string title = line.Length > 6 ? line.Substring(6) : "";
                    IntPtr h = N.FindWindow(null, title);
                    if (h != IntPtr.Zero) { N.ShowWindow(h, 9); N.SetForegroundWindow(h); }
                    break;
                }
            case "RUN":
                {
                    string cmd = line.Length > 4 ? line.Substring(4) : "";
                    var psi = new ProcessStartInfo("cmd.exe", "/c start \"\" " + cmd);
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    Process.Start(psi);
                    break;
                }
            case "Q":
                SetQuality(long.Parse(p[1]));
                break;
            case "FPS":
                Console.Error.WriteLine("fpsnote " + p[1] + " (applied by parent)");
                break;
            case "NOP":
                break;
        }
    }

    static void Mouse(uint flag)
    {
        var inp = new N.INPUT[1];
        inp[0].type = N.INPUT_MOUSE;
        inp[0].u.mi.dwFlags = flag;
        N.SendInput(1, inp, Marshal.SizeOf(typeof(N.INPUT)));
    }

    static void Key(ushort vk, bool down)
    {
        var inp = new N.INPUT[1];
        inp[0].type = N.INPUT_KEYBOARD;
        inp[0].u.ki.wVk = vk;
        inp[0].u.ki.dwFlags = down ? 0u : N.KEYEVENTF_KEYUP;
        N.SendInput(1, inp, Marshal.SizeOf(typeof(N.INPUT)));
    }

    static void TypeChar(char ch)
    {
        var inp = new N.INPUT[2];
        inp[0].type = N.INPUT_KEYBOARD;
        inp[0].u.ki.wScan = ch;
        inp[0].u.ki.dwFlags = N.KEYEVENTF_UNICODE;
        inp[1].type = N.INPUT_KEYBOARD;
        inp[1].u.ki.wScan = ch;
        inp[1].u.ki.dwFlags = N.KEYEVENTF_UNICODE | N.KEYEVENTF_KEYUP;
        N.SendInput(2, inp, Marshal.SizeOf(typeof(N.INPUT)));
        Thread.Sleep(2);
    }
}

