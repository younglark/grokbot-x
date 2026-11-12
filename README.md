# grokbot-x

Grok Bot 桌面端的非官方 Electron 增强。**不修改官方客户端**：以 `--remote-debugging-port`（只绑 127.0.0.1）启动或挂接官方 Grok Bot，再由本应用通过 Chrome DevTools Protocol（CDP）注入功能。

第一个功能 **edithere**：在图片预览窗口的「下载」按钮左边加一个「✎ 编辑」按钮，点击后在 **本应用内的窗口** 打开 [EditHere](https://github.com/Inginnng/EditHere) 网页版，并自动载入这张原图。不再调用系统 Chrome。

> ⚠️ EditHere 采用 **PolyForm Noncommercial 1.0.0**，**仅限非商业使用**。商业用途需取得作者书面授权（inginnng@163.com）。EditHere 名称与标识不在授权范围内。许可原文见应用内 `features/edithere/vendor/LICENSE` 和 `NOTICE`。

本项目与 Grok Bot 官方无关，也不受官方支持。

## 安装

从 [Releases](https://github.com/younglark/grokbot-x/releases) 下载对应平台的包：

| 平台 | 包 |
|---|---|
| Linux x64 | `.deb` 或 `.AppImage` |
| Windows x64 | `*-setup.exe`（NSIS） |
| macOS arm64 / x64 | `.dmg` 或 `.zip`（**未签名**） |

- Linux：`sudo apt install ./grokbot-x_*_amd64.deb`，或给 AppImage 加上执行权限后运行。
- Windows：运行安装器。SmartScreen 可能提示未知发布者，请从本仓库的 Releases 下载。
- macOS：**未签名**。首次打开请右键点「打开」，或执行 `xattr -dr com.apple.quarantine "/Applications/Grok Bot X.app"`。

可选依赖：Linux 上的托盘图标通常需要 `libappindicator` / `ayatana-appindicator`。没有托盘时应用仍会在后台挂接已开启调试口的 Grok Bot。

## 使用

1. 先安装官方 [Grok Bot](https://cursor.com) 桌面端。
2. 启动「Grok Bot X」。若 Grok Bot 已在运行且已带本机调试口，会直接挂接、不重启；否则请用托盘菜单里的「启动 Grok Bot（带调试口）」。若 Grok Bot 已在运行但没有调试口，会先征得同意再重启。
3. 打开对话里的图片预览，点下载按钮左边的「✎ 编辑」，会弹出内置的 EditHere 窗口。再点其他图片会复用同一个窗口。
4. 托盘菜单还可以开关功能、打开日志目录、设置（默认关闭的）开机启动，以及退出。退出本应用不会关闭 Grok Bot。

也可以在终端里运行：

```bash
GROK_BOT_BIN=/path/to/grok-bot GROK_BOT_CDP_PORT=29229 grokbot-x
```

`GROK_BOT_USER_DATA_DIR` 若设置，会同时导出 `SAND_USER_DATA_DIR`，用来隔离官方客户端的数据目录。正式使用请留空，沿用官方默认目录。

停止：托盘「退出」，或 `touch ~/.local/state/grokbot-x/stop.request`（macOS 为 `~/Library/Application Support/grokbot-x/stop.request`，Windows 为 `%LOCALAPPDATA%\grokbot-x\stop.request`）。

## 配置

`config.json` 位置：

- Linux：`~/.config/grokbot-x/config.json`
- macOS：`~/Library/Application Support/grokbot-x/config.json`
- Windows：`%APPDATA%\grokbot-x\config.json`

```json
{
  "cdpPort": 29229,
  "launcher": { "openAtLogin": false, "grokBotBin": "", "userDataDir": "" },
  "features": { "edithere": { "enabled": true, "saveImages": true } }
}
```

环境变量优先：`GROK_BOT_BIN`、`GROK_BOT_CDP_PORT`、`GROK_BOT_USER_DATA_DIR`、`GROKBOT_X_DISABLE=edithere`。

运行数据（日志、pid、按需保存的原图）在：

- Linux：`~/.local/state/grokbot-x/`
- macOS：`~/Library/Application Support/grokbot-x/`
- Windows：`%LOCALAPPDATA%\grokbot-x\`

## 架构

```
electron/main.mjs      Electron 主进程：单实例、托盘、生命周期
electron/client.mjs    查找 / 挂接 / 经同意后重启官方客户端
electron/editor.mjs    内置 EditHere 窗口（自定义协议 gx-edithere://）
core/kernel.mjs        CDP 连接、target 发现、注入、binding 消息路由
core/platform.mjs      路径、进程、对话框等平台差异
features/<name>/
  feature.mjs          { name, messageTypes, pageScript, init, onAttach, onCdpEvent, onMessage, shutdown }
  inject.js            页面脚本（独立作用域，gx = window.__grokbotX）
```

页面通过 CDP binding 发送 `{v:1, feature, type, data}`。内核会校验功能是否启用、`type` 是否在白名单里、消息是否超过 64 KB。

官方 Win / macOS 客户端的静态分析结果见 [docs/official-clients.md](docs/official-clients.md)。

## 风险

- **CDP 端口 = 完全控制客户端。** 运行期间，本机任何进程都可以通过 127.0.0.1 的调试口读写 Grok Bot 的页面、会话和登录态。只在你信任的单用户机器上使用；端口不要转发出去，也不要绑到 0.0.0.0。
- **官方升级可能打断功能。** 注入依赖 `.sand-media-viewer__download` 等页面结构，官方改版后按钮可能不再出现。找不到下载按钮时不会显示「编辑」。
- **许可证。** grokbot-x 自己的代码是 MIT。EditHere 是 PolyForm Noncommercial，仅限非商业使用。Electron、Node.js、ws 遵循各自许可证。
- 本应用的 Electron 已关闭 `RunAsNode` 与 `EnableNodeCliInspectArguments`，并打开 asar 完整性校验。这只约束 grokbot-x 自身，不会改官方客户端。

## 从源码构建

```bash
npm install
npm test
npm run start              # 开发
packaging/build-all.sh     # 当前平台的安装包
```

产物在 `release/`。macOS 包需要在 macOS 上构建；Linux 上构建 Windows 安装器需要 Wine，否则由 GitHub Actions 的 Windows runner 产出。打 `v*` 标签才会发布 Release。

官方客户端的默认查找路径：

- Linux：`/opt/Grok Bot/grok-bot`、`/usr/bin/grok-bot`、`~/Applications/*grok*bot*.AppImage`
- macOS：`/Applications/Grok Bot.app`、`~/Applications/Grok Bot.app`
- Windows：`%LOCALAPPDATA%\Programs\Grok Bot\Grok Bot.exe`、`%ProgramFiles%\Grok Bot\Grok Bot.exe`
