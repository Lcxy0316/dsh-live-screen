# dsh-live-screen

把「豆包电脑模式」那条闭环搬到 DeepSeek Harness：**本机原生采集 → 同源实时预览面板 → 模型看到屏幕 → 模型驱动鼠标键盘**。

不是远程桌面。画面在你本机采集、在你本机浏览器里渲染；云端只拿到你要它看的那一帧。

![面板实测](docs/panel.png)

## 它提供什么

| 通道 | 入口 | 用途 |
| --- | --- | --- |
| 侧边栏面板 | Harness 左侧面板图标「实时画面」 | 你自己盯着 AI 干活，可随时接管鼠标键盘 |
| 实时帧流 | `WS /live-screen/ws`（同源） | 面板用，JPEG 帧 + 双向 JSON 动作 |
| 模型工具 | `live_screen` | 模型 `snapshot` 看屏、`action` 动手 |
| HTTP | `/live-screen/{stats,screen,snapshot,action,build}` | 脚本 / 外部集成 |

## 架构

```
 Harness 页面 (React 面板)
   │  同源 WebSocket  ── 下行 JPEG 帧 / 上行动作 JSON
   ▼
 dsh-live-screen 宿主插件 (Node)
   │  spawn + stdin/stdout 二进制协议
   ▼
 ScreenHub.exe (C# / .NET Framework 4.8, 本机编译)
   │  BitBlt(屏幕 DC → DIBSection) → JPEG
   │  SendInput 注入键鼠
   ▼
 Windows 桌面
```

关键取舍：

- **采集走原生进程**，不走浏览器 `getDisplayMedia`。不用点共享、不受标签页切走后限流，息屏/锁屏之外都能抓。
- **传输同源**。`webserver.registerUpgrade()` 把原始 socket 交给插件自己的 RFC6455 实现，所以 `http://127.0.0.1:52001` 页面直接连 `ws://127.0.0.1:52001/live-screen/ws`，无 CSP、无混合内容、无跨端口。
- **零运行时依赖**。WebSocket 手写（`lib/ws.js`），图像是 JPEG，浏览器 `createImageBitmap` 解码。
- **空闲自停**。没客户端、且 30 秒没取帧，采集进程自动退出，回落到 0 内存。

## 内存与性能（实测，Dell G15 5520 / i5-12500H / 16GB / RTX 3050 Laptop）

1920×1080，12 fps 目标，JPEG q55：

| 项 | 实测 |
| --- | --- |
| Harness 宿主插件增量 | ~35 MB RSS（采集器未起时接近 0） |
| ScreenHub.exe | 26.9 MB private / 40.5 MB working set |
| ScreenHub.exe CPU | 0.86%（16 逻辑核满载口径）≈ 0.14 个核 |
| 面板（浏览器内） | ~40 MB（与已开的 Harness 页面共享进程） |
| 单帧 | ~105 KB |
| 原始码率 | ~9.7 Mbps（本机回环，不占物理网卡） |
| 首帧延迟 | 8 ms |
| 帧耗时预算 | 采集 ~20 ms + JPEG ~6 ms，1080p 上限约 35 fps |
| GPU 显存 | 0（JPEG 走 CPU，NVENC 未启用） |

**总计约 100 MB、0.15 个核**，不碰 GPU 显存（留给别的活）。

部署适配结论：**适合**。16 GB 机器上 100 MB 属于噪声级；真正的开销是 Harness 页面本身（实测页面进程 0.6–1.6 GB，比采集栈大一个数量级）。若内存吃紧，把 `scale` 降到 `0.5`（960×540，单帧 ~30 KB）或 `fps` 降到 6，采集栈几乎不变，CPU 占用线性下降。低于 8 GB 物理内存不建议开面板常驻。

## 安装

```powershell
# 1. 把本目录装进 profile（任选其一）
#    a) file: 依赖
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add file:<本目录绝对路径>
#    b) 直接拷
Copy-Item -Recurse <本目录> $env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-live-screen

# 2. 让 Loader 认识它：profile 的 package.json 里 dsh.profile.bundles 加一项
#    "dsh-live-screen"

# 3. 重启 Harness
```

首次打开面板（或首次调 `live_screen`）时，插件会用 `csc.exe` 把 `native/ScreenHub.cs` 编译成 `native/bin/ScreenHub.exe`，约 3–5 秒。之后走缓存。

要预先编译：

```powershell
pwsh -File scripts\build-native.ps1
```

前提：Windows、`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（.NET Framework 4.8 自带，无需 SDK）。

## 验证

仓库自带四个自检脚本，都不依赖 Harness 运行时：

```powershell
node scripts\verify-host.mjs     # 宿主半边：路由、WS、工具、动作分发、空闲自停（31 项）
node scripts\verify-client.mjs   # 浏览器半边：slot 注册形状、渲染树、主题 token（23 项）
node scripts\wstest.mjs <ws-url> # 裸 WS 压测：帧数 / fps / 码率 / 首帧延迟
node scripts\verify-ui.mjs <url> # 真 Harness 页面：面板真的渲染出来了吗（需 Edge）
```

前置的 `node --check` 与 `selftest.mjs` 也能单独跑。

## 配置

`cordis.patch.yml` 里给 `live-screen` 加 config：

```yaml
- id: live-screen
  config:
    fps: 12          # 目标帧率
    scale: 1         # 1 / 0.75 / 0.5
    quality: 55      # JPEG 质量 20-90
    idleMs: 30000    # 无客户端多久后停采集
```

## 工具用法

```jsonc
// 看屏幕（返回一张 image，模型真的看到画面）
{ "action": "snapshot" }

// 动手：先点搜索框，再打字，再回车
{ "action": "action", "steps": [
  { "type": "click", "x": 820, "y": 46 },
  { "type": "type", "text": "hello" },
  { "type": "key", "vk": 13, "down": true },
  { "type": "key", "vk": 13, "down": false }
] }

// 采集健康度与内存
{ "action": "stats" }
```

坐标用**原生像素**（`/live-screen/screen` 返回的 `srcWidth × srcHeight`）。面板已经把 CSS 坐标换算好了，手写脚本时注意缩放。

动作类型：`move` `click` `down` `up` `scroll` `type` `key` `focus` `run` `quality` `wait`。

## 安全边界

- 服务只监听 Harness 自己的 `webServer`（默认 `127.0.0.1`），不额外开端口。
- WebSocket 走同源升级，页面以外的地方连不上。
- 面板上的「控制」默认**关闭**：关着时只显示画面，键盘与文字不下发（点击仍然下发，因为是显式点击）。
- `run` 动作用 `cmd /c start` 启动程序，走的是你当前用户权限，没有提权。
- 要彻底停：关掉面板 + `live-screen` 面板断开，30 秒后采集进程自己退。

## 已知限制

- 只支持 Windows（`SendInput` + `BitBlt`）。
- 抓的是**整个桌面**，不是单个窗口。面板里出现自己是一种正常的无限镜像。
- 独占全屏的 D3D 游戏可能抓到黑屏（`BitBlt` 的限制）；换成桌面级捕获需要 `Windows.Graphics.Capture`，目前没做。
- 多显示器只抓主屏。
- 需要交互式会话（`SESSIONNAME=Console`）。跑在服务里抓不到桌面。

## License

MIT
