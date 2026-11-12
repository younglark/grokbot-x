# grokbot-x

Grok Bot 桌面端的非官方增强启动器。**不修改官方客户端**：以 `--remote-debugging-port`（只绑 127.0.0.1）启动官方 Grok Bot，再由用户级守护进程通过 Chrome DevTools Protocol（CDP）注入功能。

第一个功能 **edithere**：在图片预览窗口的「下载」按钮左边加一个「✎ 编辑」按钮，点击后在独立的 Chrome/Chromium 窗口里打开 [EditHere](https://github.com/Inginnng/EditHere) 网页版，并自动载入这张原图。

> ⚠️ EditHere 采用 **PolyForm Noncommercial 1.0.0**，**仅限非商业使用**。商业用途需取得作者书面授权（inginnng@163.com）。EditHere 名称与标识不在授权范围内。许可原文见 `/opt/grokbot-x/features/edithere/vendor/LICENSE` 和 `NOTICE`。

## 安装

```bash
sudo apt install ./grokbot-x_0.1.0_amd64.deb
```

依赖：bash、procps、coreutils。推荐：`google-chrome-stable` 或 `chromium`（EditHere 窗口用），`zenity`（对话框）。安装包自带 Node.js 22 运行时和 ws，不需要系统 Node。

## 卸载

```bash
grokbot-x-stop            # 先停守护进程
sudo apt remove grokbot-x
rm -rf ~/.local/state/grokbot-x ~/.config/grokbot-x   # 可选：删运行数据和配置
```

## 使用

- 从应用菜单打开「Grok Bot X」，或在终端运行 `grokbot-x`。
- 打开对话里的图片预览，点下载按钮左边的「✎ 编辑」，就会弹出 EditHere 窗口。再点其他图片会复用同一个窗口。
- 停止增强（Grok Bot 不受影响）：`grokbot-x-stop`，或桌面菜单里的「停止 grokbot-x 增强」。Grok Bot 退出后，守护进程也会自动退出。

启动器的行为：

1. 依次查找官方客户端：`GROK_BOT_BIN` → `/opt/Grok Bot/grok-bot` → `/opt/grok-bot/grok-bot` → `/usr/bin/grok-bot` → `~/Applications/*grok*bot*.AppImage` → `~/.config/grokbot-x/launcher.conf` 里的 `GROK_BOT_BIN`。
2. Grok Bot 已在运行、并且已经开了 127.0.0.1 调试口：直接挂上，不重启。
3. 已在运行但没开调试口：弹窗询问，同意后才重启（没有 zenity 就在终端里问；没有终端就放弃）。
4. 没在运行：带 `--remote-debugging-port=<端口> --remote-debugging-address=127.0.0.1` 启动。`chrome-sandbox` 不是 setuid root、用户命名空间也不可用时（或者是 AppImage），才加 `--no-sandbox`。
5. 启动守护进程（用户级后台进程，不装 systemd 服务）。

### 配置

`~/.config/grokbot-x/launcher.conf`（shell 格式，环境变量优先）：

```bash
GROK_BOT_BIN="/path/to/grok-bot"
GROK_BOT_CDP_PORT=29229            # 默认 29229；被占用时自动往后找空闲端口
GROK_BOT_USER_DATA_DIR=""          # 留空 = 正常用户数据；设置后同时导出 SAND_USER_DATA_DIR，做隔离
GROK_BOT_EXTRA_ARGS=""
```

`~/.config/grokbot-x/config.json`（覆盖 `/opt/grokbot-x/config/default.json`）：

```json
{ "features": { "edithere": { "enabled": true, "browser": "", "staticPort": 0, "browserCdpPort": 0, "saveImages": true } } }
```

端口填 `0` 表示自动选空闲端口。也可以用环境变量临时禁用某个功能：`GROKBOT_X_DISABLE=edithere`。

### 运行数据

`~/.local/state/grokbot-x/`：`daemon.log`、`grokbot-x.log`、`grok-bot.log`、`daemon.pid`；`features/edithere/` 下有 EditHere 浏览器的独立 profile（`browser-profile/`）、`browser.log`，以及点击时取到的原图（`images/`，`saveImages:false` 可以关掉）。

## 架构（插件化）

```
core/daemon.mjs        内核：读配置、连 CDP、发现 target、注入、binding 消息路由
core/page-runtime.js   页面运行时：window.__grokbotX.send(feature, type, data)
features/<name>/
  feature.mjs          daemon 端：{ name, messageTypes, pageScript, init, onAttach, onCdpEvent, onMessage, shutdown }
  inject.js            页面端片段（包在独立作用域里，拿到 gx = window.__grokbotX）
```

页面通过 CDP binding `__grokbotXBridge` 发 `{v:1, feature, type, data}`。内核会校验：功能是否启用、`type` 是否在该功能的 `messageTypes` 白名单里、消息不超过 64 KB；通过后才交给对应功能。加新功能就是新建 `features/<name>/`，不用改内核。

## 风险

- **CDP 端口 = 完全控制客户端。** 运行期间，本机任何进程都能通过 127.0.0.1 的调试口读写 Grok Bot 的页面、会话和登录态。只在你信任的单用户机器上使用；端口不要转发出去，也不要绑到 0.0.0.0。
- **官方升级可能打断功能。** 注入依赖 `.sand-media-viewer__download` 等页面结构，官方改版后按钮可能不再出现。找不到下载按钮时不会显示「编辑」，不影响官方功能本身。
- **页面里的脚本也能调用 binding。** 内核只接受白名单消息；edithere 只接受 `sand-media:`、`https:`、`blob:`、`file:` 图片地址，并且只读当前预览里的那张图。
- **许可证。** grokbot-x 自己的代码是 MIT。EditHere 是 PolyForm Noncommercial，仅限非商业使用。Node.js、ws 各自遵循自己的许可证（包内都有）。
- 本项目与 Grok Bot 官方无关，也不受官方支持。

## 构建

```bash
packaging/build-deb.sh     # 产出 release/grokbot-x_<版本>_amd64.deb（Node/ws 按固定版本下载并校验 SHA-256）
```
