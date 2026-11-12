# 上游来源与修改说明

本目录是 [EditHere](https://github.com/Inginnng/EditHere) 网页编辑器源码的**派生分叉**，由 grokbot-x 自行维护。

- 上游仓库：https://github.com/Inginnng/EditHere
- 复制时所依据的 commit：`3dab2c4a1a5952cbd567ec89473112c824e4d790`（标签 v0.13.0，2026-11-12）
- 上游许可：**PolyForm Noncommercial License 1.0.0**（见本目录 `LICENSE`）
- Required Notice：Copyright 2026 Inginnng (https://github.com/Inginnng/EditHere)（见 `NOTICE`）
- 本派生版本号（不再读取上游 CMakeLists）：`0.13.0-grokbot-x.1`

本派生仅用于 grokbot-x 的**个人或内部非商业使用**。商业使用须另行取得 EditHere 作者书面授权（inginnng@163.com）。

## 商标政策（TRADEMARK-POLICY）

EditHere 的名称、Logo 与品牌元素**不在** PolyForm 授权范围内。政策要求：对外发布的修改版**必须改用自己的名称与标识**，并在显著位置说明它是派生版本、与原项目无隶属关系。

因此本派生：

- 产品与窗口名称使用 **「图片批注」**，应用品牌为 **grokbot-x**，不把 EditHere /「改这里」当作本应用的品牌或主标识。
- 界面与文档使用 grokbot-x 自己的图标；上游 lockup / logo 仅保存在 `assets/upstream-brand/` 备查，**不会**嵌入构建产物或用作窗口图标。
- 在界面与 README 中标注：「派生自 EditHere，与原作者无隶属关系」。允许真实指代上游项目及「兼容 EditHere 反馈格式」。
- 内部功能目录名、代码标识符（如 `features/edithere`、`EditHereWeb`）以及反馈 JSON 里的 `tool.name = "EditHere"` 仅为兼容原有反馈格式与源码结构，不是产品名称。

详见本目录 `TRADEMARK-POLICY.md`。

## 复制清单（仅网页编辑器所需）

从上游 `web/src/` 复制：

- `shell.html` `style.css` `help.css`
- `layout.js` `image-format.js` `feedback.js` `bundle.js`
- `detector.js` `help.js` `ui.js` `app.js` `agent.js`

**未复制**的上游网页变体：`dsh-bridge.js`、`mcp-app.js`、以及任何桌面/MCP/DSH 专用入口。上游桌面端「生成修改意见」（依赖外部大模型 API）不在此次复制的 web 源码中；本派生也不会加入该功能，且页面 CSP 保持 `connect-src 'none'`，禁止联网。

从上游 `assets/` 复制：

- `assets/ui-icons/`（`LICENSE`、`manifest.json`、`README.md`、`icons/*.svg` 共 67 个图标）
- 上游品牌与图标（仅归档，不用于本应用品牌）：`assets/upstream-brand/`（`edithere-lockup.svg`、`edithere-lockup-light.svg`、`edithere.svg`、`README.md`、`Manrope-OFL.txt`）

从上游仓库根目录复制：`LICENSE`、`NOTICE`、`TRADEMARK-POLICY.md`。

## 本派生新增 / 修改的文件

新增（grokbot-x 所有）：

- `build.mjs` — 自有构建脚本（参考上游 `web/build.cjs` 的内联逻辑，版本号为常量）
- `src/host.js` — 宿主适配：通过 `window.grokbotX`（preload / contextBridge）与 Electron 主进程通信
- `src/host.css` — 宿主信息条与「图片批注」品牌样式
- `UPSTREAM.md`（本文件）
- 构建产物：`features/edithere/build/editor.html`（生成文件，不入库）

在上游源码上的修改（均已标注「Modified by grokbot-x」）：

- `src/shell.html` — 窗口标题与顶栏改为「图片批注」；去掉 EditHere Logo；加入宿主信息条与 `/*__HOST__*/`；空状态与帮助中的归属说明
- `src/app.js` — 将下载 / 复制 JSON / 复制 JSON 与图片 / 保存项目等导出路径接到宿主 IPC；增加 `GrokbotXEditorHooks`
- `src/feedback.js` — 产品版本改为使用构建常量 / `<meta name="edithere-version">`，不再读取 CMakeLists.txt
- `src/help.js` — 帮助文案改为文件导出（不回填 Grok Bot），并注明派生关系

## 构建

```bash
node features/edithere/editor/build.mjs
# 生成 features/edithere/build/editor.html
```

`npm test`、`npm start` 以及 `npm run dist` / `dist:linux` / `packaging/build-all.sh` 会在打包前先运行该脚本。
