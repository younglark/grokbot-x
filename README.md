# grokbot-x

Grok Bot 桌面端的非官方 Electron 增强。**不修改官方客户端**：以 `--remote-debugging-port`（只绑 127.0.0.1）启动或挂接官方 Grok Bot，再由本应用通过 Chrome DevTools Protocol（CDP）注入功能。

第一个功能 **图片批注**（内部目录名 `edithere`）：在图片预览窗口的「下载」按钮左边加一个「✎ 编辑」按钮，点击后在 **本应用内的窗口** 打开派生自 [EditHere](https://github.com/Inginnng/EditHere) 的本地编辑器，并自动载入这张原图。导出只保存到本地文件，**不会回填 Grok Bot**。不再调用系统 Chrome，也不再使用上游已经构建好的单文件 HTML。

第二个功能 **Bot 透视**（内部目录名 `bot-inspector`）：在窗口右侧注入一个只读的「跨 bot 状态条」。顶部汇总 总数 / 运行中 / 等你回复 / 空闲 / 未读，下面每个 Bot 一行：状态圆点（等你回复=琥珀、运行中=绿、重试=橙、空闲=灰）、名称、状态与实时工具（如「运行中·执行工具 · WebSearch」）、重试 / 等你接手标记、未读角标、最近消息预览和相对时间。排序为 等你回复 → 运行中 → 空闲，同组按最近活动倒序。样式直接使用客户端自带的 `--sand-*` 设计变量，随客户端主题变化。数据只从页面里已有的名册对象读取，**不调用官方 RPC，也不改任何状态**。额度、任务、会话等不在这份名册里，面板不会编造。

第三个功能 **交互预览验收**（内部目录名 `preview`）：对话里出现 `.zip` 附件卡时，在卡片下方加一个「▶ 打开预览」按钮。点击后把这个验收包在 **grokbot-x 的隔离窗口** 里打开；包内页面自己渲染反馈 UI（grokbot-x **不代画任何表单**），页面调用 `window.__grokbotXPreview.submitFeedback({ json, files })` 后，反馈 JSON 和附件写到本地反馈目录并放进系统剪贴板，由你自己粘贴回对话。**永远不会自动发送消息。** 包的写法见内置 skill `skills/preview-review/`（第 5 节是桥接约定，`examples/` 是可直接打包的多 Tab 模板）。

> ⚠️ 编辑器源码派生自 EditHere，采用 **PolyForm Noncommercial 1.0.0**，**仅限个人或内部非商业使用**。商业用途需取得 EditHere 作者书面授权（inginnng@163.com）。按上游 [商标政策](features/edithere/editor/TRADEMARK-POLICY.md)，本应用不以 EditHere 为自己的产品名或 Logo；窗口标题为「图片批注」，并注明「派生自 EditHere，与原作者无隶属关系」。许可与来源说明见 `features/edithere/editor/LICENSE`、`NOTICE`、`UPSTREAM.md`。

本项目与 Grok Bot 官方无关，也不受官方支持。

## 一键安装

从 GitHub Release 安装最新稳定版。默认装到当前用户目录，**不需要 sudo / 管理员权限**；不会开启登录自启，也不会附带安装官方 Grok Bot。

Linux / macOS：

```bash
curl -fsSL https://github.com/younglark/grokbot-x/releases/latest/download/install.sh | bash
```

Windows（PowerShell）：

```powershell
irm https://github.com/younglark/grokbot-x/releases/latest/download/install.ps1 | iex
```

- 第一个带应用内自动更新的版本是 **0.2.0**。已经安装 0.1.0 的用户需要手动装一次 0.2.0，之后才会自动检查并提示更新。
- 安装包目前**未签名**。Windows 可能出现 SmartScreen 提示；macOS 首次打开请右键点「打开」。
- Linux 的应用内更新只支持 AppImage（一键安装走的就是 AppImage）。用 `.deb` 安装的需要自行下载新版本。
- 启动后会检查 GitHub Release，有更新时后台下载，下完再提示重启安装（不会静默重启）。也可在托盘菜单点「检查更新」。

## 手动安装

也可以从 [Releases](https://github.com/younglark/grokbot-x/releases) 下载对应平台的包：

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
3. 打开对话里的图片预览，点下载按钮左边的「✎ 编辑」，会弹出内置的「图片批注」窗口。再点其他图片会复用同一个窗口。批注后的 JSON / 图片默认保存到状态目录下的 `features/edithere/exports/<时间戳>/`，也可在窗口顶栏点「另存为…」自选位置。
4. 对话或输入框里的 `.zip` 附件卡下方会出现「▶ 打开预览」。点击后会弹出「交互预览验收」窗口；填完页面里的反馈点它自己的「复制全部反馈」，再回到 Grok Bot 粘贴即可。拿不到 zip 时会弹出文件选择框（默认定位到「下载」目录里的同名文件）：先点附件卡自带的下载按钮保存，再选中它。托盘里的「打开本地验收 zip…」可以直接打开本机的包。
5. 挂接成功后，Grok Bot 窗口右侧会出现「Bot 透视」标签，点开即可查看所有 Bot 的只读运行状态；可用面板上的关闭按钮或再次点击标签收起。
6. 托盘菜单还可以开关功能、打开日志目录、设置（默认关闭的）开机启动，以及退出。退出本应用不会关闭 Grok Bot。

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
  "features": { "edithere": { "enabled": true, "saveImages": true }, "bot-inspector": { "enabled": true }, "preview": { "enabled": true } }
}
```

`features.preview` 还可以覆盖上限（字节）：`maxZipBytes`（默认 50 MB）、`maxUnpackedBytes`（200 MB）、`maxEntryBytes`（100 MB）、`maxEntries`（2000）、`maxFeedbackFiles`（20）、`maxFeedbackFileBytes`（25 MB）、`maxFeedbackTotalBytes`（100 MB）、`clipboardMaxBytes`（50 MB，附件合计超过它时剪贴板里只放反馈目录路径和 JSON 文本）。

环境变量优先：`GROK_BOT_BIN`、`GROK_BOT_CDP_PORT`、`GROK_BOT_USER_DATA_DIR`、`GROKBOT_X_DISABLE=edithere,bot-inspector,preview`。

运行数据（日志、pid、按需保存的原图、编辑器导出）在：

- Linux：`~/.local/state/grokbot-x/`
- macOS：`~/Library/Application Support/grokbot-x/`
- Windows：`%LOCALAPPDATA%\grokbot-x\`

## 架构

```
electron/main.mjs                 Electron 主进程：单实例、托盘、生命周期
electron/updater.mjs              应用内自动更新（仅打包版；Linux 限 AppImage）
electron/client.mjs               查找 / 挂接 / 经同意后重启官方客户端
electron/editor.mjs               内置「图片批注」窗口（gx-edithere:// + preload IPC）
electron/preload-edithere.cjs     contextBridge：window.grokbotX
electron/edithere-ipc.mjs         主进程 IPC 参数校验（可单独跑测试）
core/kernel.mjs                   CDP 连接、target 发现、注入、binding 消息路由
core/platform.mjs                 路径、进程、对话框等平台差异
features/edithere/
  feature.mjs                     捕获预览图并打开编辑器
  inject.js                       在官方预览里插入「✎ 编辑」
  editor/                         派生自 EditHere 的网页源码（见 UPSTREAM.md）
  editor/build.mjs                生成 build/editor.html
  editor/src/host.js              宿主适配（接收图片、把导出交给 IPC）
  build/editor.html               构建产物（不入库）
electron/preview.mjs              「交互预览验收」窗口、127.0.0.1 临时服务、提交 IPC、剪贴板
electron/preview-core.mjs         解压（防 zip slip）、review.json、桥接注入、服务路由、反馈落盘（纯 Node，可单测）
electron/preload-preview.cjs      contextBridge：外壳页的 window.gxPreviewHost
features/preview/
  feature.mjs                     接「打开预览」点击，按来源链拿 zip，交给 electron/preview.mjs
  inject.js                       在 .zip 附件卡下方插入「▶ 打开预览」
features/bot-inspector/
  feature.mjs                     功能清单（无主进程消息）
  format.mjs                      时间、状态文案等纯函数（测试与注入脚本共用）
  inject.js                       注入只读「Bot 透视」跨 bot 状态条
```

页面通过 CDP binding 发送 `{v:1, feature, type, data}`。内核会校验功能是否启用、`type` 是否在白名单里、消息是否超过 64 KB。

### 交互预览验收的工作方式

1. **识别**：`inject.js` 扫消息里的 `article.sand-file-card` 和输入框里的 `[data-attachment-card]` / `.sand-attachment-chip`，按文件名（`bdi[title]` 或叶子文本）认出 `.zip`。附件来源取卡片 React props 里的 `href`（消息卡）或 `filePath`（输入框），只读不改。点击经 `window.__grokbotX.send('preview', 'open', { name, source, meta, origin })` 报给主进程。
2. **取 zip**（`features/preview/feature.mjs`，按顺序，第一个成功即停）：外部注册的 hook（`registerZipSource`）→ `local-path`（来源是本机已存在的 `.zip` 绝对路径）→ `cdp-resource`（`Page.getResourceContent`）→ `cdp-network`（`Network.getResponseBody`，只记录 zip 响应）→ `https-fetch`（公开 https，不带凭据）→ `downloads`（「下载」目录里 30 分钟内的同名文件，大小与卡片显示相符）→ `pick-file`（文件选择框，由你确认）。**不调用客户端的 `desktop.*` 接口或任何后端 RPC，不读 cookie / 令牌。** 消息附件的来源一般是云端电脑上的路径，桌面端只能通过官方的 `desktop.readAttachmentBytes` / `downloadAttachment` 去读，所以多数情况下要先点附件卡自带的下载按钮，再走 `downloads` / `pick-file`。
3. **打开**：zip 解到状态目录 `features/preview/opened/<token>/`（窗口关闭即删除；先拒绝绝对路径、`..`、符号链接、加密条目、ZIP64，限制压缩包 / 解压后 / 单文件大小和条目数，CRC 校验）。本地 HTTP 服务只绑 `127.0.0.1` 的随机端口，只认 `Host: 127.0.0.1:<port>`，路径带 128 位随机 token，最后一个窗口关掉就停止。窗口用独立的内存分区（不落 cookie / storage）、`sandbox` + `contextIsolation`，`webRequest` 只放行本服务的地址（包里引用的外网资源会被拦下），禁止新窗口和外跳导航。
4. **隔离**：外壳页只有一个整窗 `<iframe sandbox="allow-scripts allow-forms allow-modals">`，**没有 `allow-same-origin`**，预览页是不透明源，访问不到外壳、`gxPreviewHost`、cookie 或 storage。
5. **桥接**：服务在下发 `review.json` 的 `entry`（默认 `index.html`）时临时插入一段 `<script data-grokbotx-preview-bridge>`，定义 `window.__grokbotXPreview = { v: 1, autoSend: false, submitFeedback }`；zip 里的文件不被修改，其他 HTML 不注入。`submitFeedback` 用 `postMessage` 交给外壳，外壳经 preload / IPC 交给主进程，返回 Promise（成功 resolve `{ mode, dir, files }`，失败 reject）。
6. **反馈**：主进程校验（JSON 必须是对象、≤ 2 MB；附件个数与大小受限），写到 `features/preview/feedback/<时间戳>-<随机>/feedback.json` + 附件；`feedback.json` 追加 `feedbackFiles`（附件绝对路径）和 `grokbotxPreview`（包名、标题、`autoSent: false`）。剪贴板：没附件时放 JSON 文本；有附件时放文件列表（JSON 在前，复用 `electron/clipboard-files.mjs`）；附件合计超过 `clipboardMaxBytes` 或文件列表写入失败时，放「反馈目录路径 + JSON 文本」。之后只弹系统通知，**不会往对话里发任何东西**。

`review.json` 只读 `title` / `entry` / `scene` / `tabs`，其他字段（包括旧的 `fields`、`mode: "form"`）会被忽略并记一条日志。开发时可用 `grokbot-x --open-preview /path/to/review.zip` 直接打开。

官方 Win / macOS 客户端的静态分析结果见 [docs/official-clients.md](docs/official-clients.md)。


## 如何修改编辑器

编辑器是分叉后的源码，直接改 `features/edithere/editor/` 即可，不必再去改上游已经构建好的 HTML。

1. 界面结构在 `editor/src/shell.html`，样式在 `style.css` / `host.css`。顶栏的图片尺寸和默认导出路径是一个最小定制示例（`host.js` + `#host-bar`），可按同样方式加自己的提示或按钮。
2. 编辑逻辑在 `editor/src/app.js` 等文件。与 Electron 的交互不要用 `executeJavaScript`，应走 `editor/src/host.js` → `window.grokbotX`（由 `electron/preload-edithere.cjs` 经 contextBridge 暴露）→ 主进程 IPC。新增接口时要在 `electron/edithere-ipc.mjs` 里做参数校验。
3. 改完后运行 `npm run build:editor`（`npm start` / `npm test` / 打包脚本会自动跑）。产物是 `features/edithere/build/editor.html`。
4. 请在改过的上游文件里保留「Modified by grokbot-x」标注，并视情况更新 `editor/UPSTREAM.md`。不要把 EditHere 的名称或 Logo 用作本应用品牌。

开发时可用 `grokbot-x --open-image /path/to/test.png` 直接打开编辑器（不必点击对话里的用户图片）。触摸状态目录下的 `self-test-export.request` 或加上 `--self-test-export` 可测试导出。

## 风险

- **CDP 端口 = 完全控制客户端。** 运行期间，本机任何进程都可以通过 127.0.0.1 的调试口读写 Grok Bot 的页面、会话和登录态。只在你信任的单用户机器上使用；端口不要转发出去，也不要绑到 0.0.0.0。
- **官方升级可能打断功能。** 注入依赖 `.sand-media-viewer__download` 等页面结构，官方改版后按钮可能不再出现。找不到下载按钮时不会显示「编辑」。
- **交互预览验收会运行包里的脚本。** 只打开你信任的验收包。它跑在隔离窗口的 sandbox iframe 里（不透明源、内存分区、只允许访问本机临时服务），拿不到 Grok Bot 的页面、会话或 grokbot-x 的接口；但预览运行期间，本机其他进程在知道随机端口和 token 的前提下可以读到这个包的文件。服务只绑 127.0.0.1，不要转发。
- **反馈只进剪贴板。** grokbot-x 不代画表单，也不会把反馈自动发进对话；粘贴前请自己看一眼剪贴板内容。反馈目录在状态目录下，不会自动清理，托盘「打开验收反馈目录」可查看。
- **附件识别依赖官方 DOM。** `.sand-file-card`、`[data-attachment-card]` 和卡片 props 的字段名来自对官方 1.0.1 渲染包的静态分析，官方改版后按钮可能不出现或拿不到来源，这时仍可用托盘「打开本地验收 zip…」。
- **许可证。** grokbot-x 自己的代码是 MIT。派生的图片批注编辑器来自 EditHere，是 PolyForm Noncommercial，仅限个人或内部非商业使用。Electron、Node.js、ws 遵循各自许可证。
- 本应用的 Electron 已关闭 `RunAsNode` 与 `EnableNodeCliInspectArguments`，并打开 asar 完整性校验。这只约束 grokbot-x 自身，不会改官方客户端。

## 从源码构建

```bash
npm install
npm test
npm run start              # 开发（会先构建编辑器）
packaging/build-all.sh     # 当前平台的安装包
```

产物在 `release/`（含 `latest-*.yml` / `.blockmap` 等自更新元数据）。macOS 包需要在 macOS 上构建；Linux 上构建 Windows 安装器需要 Wine，否则由 GitHub Actions 的 Windows runner 产出。本地打包使用 `--publish never`，不会向 GitHub 发布。打 `v*` 标签才会由 Actions 创建 Release 并挂上三平台安装包和 `install.sh` / `install.ps1`。

官方客户端的默认查找路径：

- Linux：`/opt/Grok Bot/grok-bot`、`/usr/bin/grok-bot`、`~/Applications/*grok*bot*.AppImage`
- macOS：`/Applications/Grok Bot.app`、`~/Applications/Grok Bot.app`
- Windows：`%LOCALAPPDATA%\Programs\Grok Bot\Grok Bot.exe`、`%ProgramFiles%\Grok Bot\Grok Bot.exe`
