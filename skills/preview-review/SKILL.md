---
name: 交互预览验收包
description: >-
  当你要交付需要人工体验才能验收的成果（视觉稿、动画/过渡、可点交互原型、响应式布局、数据/图表、文案多语言、多方案对比等），想让用户在独立窗口里真正体验、再把结构化反馈回传给你时使用。产出一个含
  index.html 的自包含预览 zip：单页多 Tab 组合验收场景，反馈 UI 由页面自己渲染，最后一次性复制全部反馈；由 grokbot-x 桌面扩展打开并提供复制通道。
---
给需要人工体验才能验收的成果（尤其视觉、动画、交互）做一个自包含预览包：用户在独立窗口里体验，**页面自己渲染反馈 UI**，填好后调用宿主桥接一键复制，再粘回对话交给你。

**依赖**：打开预览与「复制反馈」通道由 grokbot-x 桌面扩展提供。没装 grokbot-x 时，这个 zip 仍是普通附件，用户只能下载、手动打开 index.html——所以 zip 自身要能独立打开，并自带「复制 JSON / 下载反馈」降级。

**底线**：
- 反馈 UI 一律由附件里的页面自己渲染，grokbot-x **不代画**任何表单。
- index.html 完全自包含、相对路径、不依赖外网、无需登录。
- 预览包里只放要验收的内容；凭据、令牌、会话、用户隐私一概不写进去。
- 任何消息都不自动发送：反馈永远是「用户复制→用户粘贴」。
- 预览包是**可套用的验收模板**，不是一次性示意图。交互要真实可操作，功能要能真正用来验收，UI 要整洁好看。先套用预制模板再改成本次交付内容。

参考实现（普通浏览器可直接打开）：https://younglark.github.io/preview-review-examples/ ，源码与可下载 zip：https://github.com/younglark/preview-review-examples

## 1. 什么时候用

当交付物要「看/点/体验」才能判断好坏，而不是读文字就能验收时。典型：UI 视觉稿、动画与过渡、可点交互原型、响应式多尺寸、数据看板/图表、文案或多语言校对、多方案 A/B 对比。纯文本结论、只读报告直接在对话里回，不用这个。

## 2. 产出什么

一个 zip，解开后根目录结构：

```
index.html          必需，预览入口（也渲染反馈 UI；可被 review.json.entry 覆盖）
review.json         必需，验收元信息（见第 5 节）
assets/ …           相对路径引用的 css/js/图片/视频/字体等
app/ …              可选，被验收的真实构建页面（配合第 4 节 iframe 方式嵌入）
```

把 zip 作为**附件**发到对话里（和平时发文件一样），一句话说明这是待验收的预览、点「打开预览」体验即可。只发这个附件，不发链接、不附带发送别的东西。

## 3. 推荐形态：单页多 Tab，最后一起复制

一次交付若涉及多个验收面（视觉、动画、交互走查、响应式、总评等），**默认做在同一个 index.html 里**：顶部 Tab 切换场景，每个 Tab 自带预览区与反馈区，状态在内存累积，页脚一个「复制全部反馈」把所有 Tab 的结论一次打包。多场景就用 Tab 组合，别打成多个独立页面或多个 zip 让用户重复打开、分次复制。

一次性反馈的 JSON 形状：

```json
{
  "v": 1,
  "title": "晨光咖啡 App 改版验收",
  "scene": "bundle",
  "tabs": {
    "visual": { "scene": "visual", "verdict": "需修改", "regions": [], "note": "" },
    "animation": { "scene": "animation", "verdict": "通过", "timeline": [], "note": "" }
  },
  "filled": 2,
  "total": 2
}
```

每个 Tab 的对象遵守第 6 节对应场景的字段。回读时按 `tabs` 逐项处理，只处理用户填了的项。

## 4. 预览怎么做：两条路径

**路径 A（首选）——嵌真实构建页面**。要验收的是一个真实页面（登录页、某个真实界面）时，用 `<iframe>` 直接把构建好的页面嵌进来，不要为验收另写一套界面逻辑：

```html
<iframe src="app/login.html?review=1"
        sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
```

真实页面里只加一个小桥接 `app/review-bridge.js`，**只有带 `review` 参数时才激活**，通过 `postMessage` 和外层验收壳通信（外层监听 `type:"preview-review"`）：

```js
// review-bridge.js（真实页面侧）
const params = new URLSearchParams(location.search);
const mode = params.get("review");          // 如 "1" / "visual"
window.PreviewReview = {
  enabled: !!mode, mode,
  send(type, data) {                          // 把事件报给外层验收壳
    if (mode) parent.postMessage({ type: "preview-review", kind: type, data }, "*");
  },
  onCommand(fn) {                             // 接外层指令（如跳帧、设断点）
    window.addEventListener("message", (e) => {
      if (e.data && e.data.type === "preview-review-cmd") fn(e.data.kind, e.data.data);
    });
  }
};
```

好处：**同一份页面既能正常跑（无参数时桥接不激活、逻辑不受影响），又能验收**（带参数时上报交互、接收指令）。响应式只改 iframe 宽度即可复用真实媒体查询。

**路径 B——页面内自己摆预览**。被验收的是还没构建的稿子、纯动画、示意交互时，在 index.html 里直接画可操作的预览。

无论哪条路径，预览都要满足：

- 自包含、相对路径、不引用任何外部 URL/CDN/远程字体/接口、不需登录、不写死密钥或用户数据。
- 能在普通浏览器直接双击打开（grokbot-x 会放进隔离沙箱 iframe 打开，禁止访问父页面和 cookie）。
- 把「被验收的东西」做成**能真正体验的交互**（各场景的具体要求见第 6 节），不要只放静态截图充数。
- **反馈 UI 由页面自己画**：收集好后调用第 5 节桥接提交；没扩展时降级为「复制 JSON / 下载反馈」。

## 5. review.json 与提交桥接

`review.json` 只记验收元信息，不负责表单结构：

```json
{ "v": 1, "title": "晨光咖啡 App 改版验收", "entry": "index.html", "scene": "bundle", "tabs": ["visual", "animation", "prototype", "responsive", "general"] }
```

`scene` 标明场景（见第 6 节；多 Tab 包用 `bundle`），`tabs` 只列本次真正要验收的场景，供你回读对照，不影响渲染。只有一个场景时 `scene` 写该场景名、省去 `tabs`。

页面侧提交（桥接由 grokbot-x 注入，取用前判空以便无扩展时降级）：

```js
const bridge = window.__grokbotXPreview;
const payload = {
  title: '晨光咖啡 App 改版验收',
  scene: 'animation',
  verdict: '需修改',
  note: '第 2 帧按钮抖动过强',
  // 另加场景专属字段：regions / timeline / checklist / items 等
};
if (bridge && bridge.submitFeedback) {
  bridge.submitFeedback({ json: payload, files: filesFromInputsOrDrop /* File[]，可省 */ });
} else {
  navigator.clipboard.writeText(JSON.stringify(payload, null, 2)); // 降级：用户再手动交回
}
```

桥接约定：`window.__grokbotXPreview.submitFeedback({ json, files })`。`json` 是结构化反馈对象，`files` 是可选 `File[]`。宿主把 JSON + 附件一起放进剪贴板；大文件超剪贴板时退回一个反馈目录路径。

## 6. 各场景反馈模板（按需写进预览包）

这些是**供套用、参考的预制模板**。产出 zip 时，按本次交付需要的场景把对应预览做成能真正操作的画面、把对应反馈 UI 写进 index.html；多场景按第 3 节用 Tab 组合。每项反馈都保留 `scene` 和 `verdict`，附件（截图/录屏）走 `files` 桥接、不写进 JSON。场景字段可混用（例如响应式 + 打点标注），多 Tab 包外层 `scene` 为 `bundle`。

### 通用兜底（`scene: "general"`）
单选通过/需修改/不通过；多行备注；附件上传。
```json
{ "title": "…", "scene": "general", "verdict": "需修改", "note": "…" }
```

### 静态视觉稿（`scene: "visual"`）
预览区在图上点选打点（相对坐标 + 评论），标注可删可改；多张稿可分区；加总结论。
```json
{ "scene": "visual", "verdict": "需修改", "regions": [ { "image": "hero.png", "x": 0.42, "y": 0.31, "comment": "按钮对齐偏左" } ], "note": "…" }
```

### 动画 / 过渡（`scene: "animation"`）
预览区给**可拖进度条**：点击跳转、拖动播头，按住后在 `window` 上监听 move/up（鼠标移出细条仍能拖）；慢放/正常/快放/重播；空格播放暂停、左右箭头精确跳转。时钟由页面自己控制（如 WAAPI `animation.currentTime`），不交给原生 `<video>` 控件。在某一刻加评论是独立操作（专门按钮或双击轨道），与拖动跳转分开——否则进度条会拖不动。允许上传录屏或问题帧截图。
```json
{ "scene": "animation", "verdict": "需修改", "timeline": [ { "t": 0.32, "frame": 8, "comment": "按钮抖动过强" } ], "note": "…" }
```

### 可点交互原型（`scene: "prototype"`）
按钮、切页、表单能点、能走完主路径，配走查清单：每步通过/卡住/有问题 + 自由意见 + 录屏上传。
```json
{ "scene": "prototype", "verdict": "需修改", "checklist": [ { "id": "open", "label": "打开登录页", "status": "pass" }, { "id": "submit", "label": "点击登录", "status": "stuck", "comment": "按钮无反应" } ], "note": "…" }
```

### 响应式 / 多尺寸（`scene: "responsive"`）
预览区切换断点，布局随断点真正变，切换器常驻可见、不挡画面；每个断点一个通过/需改 + 断点级备注。逻辑分区可折叠时更好查。
```json
{ "scene": "responsive", "breakpoints": [ { "name": "mobile-375", "verdict": "需改", "note": "底栏遮住按钮" }, { "name": "desktop-1280", "verdict": "通过" } ], "verdict": "需修改" }
```

### 数据 / 图表（`scene: "data"`）
按行/指标逐项核对（表格式，每项勾对错）+ 异常标注。
```json
{ "scene": "data", "items": [ { "id": "revenue", "label": "本月营收", "ok": false, "comment": "与源数据不一致" }, { "id": "trend", "label": "趋势线", "ok": true } ], "verdict": "需修改" }
```

### 文案 / 多语言（`scene: "copy"`）
逐条批改（原文→建议改法）+ 术语一致性勾选。
```json
{ "scene": "copy", "edits": [ { "id": "cta", "original": "立即开始", "suggested": "立即体验", "reason": "与产品语气不符" } ], "glossaryOk": true, "verdict": "需修改" }
```

### 多方案 A/B（`scene: "compare"`）
选偏好方案 + 理由 + 各方案优缺点。
```json
{ "scene": "compare", "preferred": "B", "reason": "信息层级更清楚", "options": [ { "id": "A", "pros": "色彩更亮", "cons": "主按钮不够突出" }, { "id": "B", "pros": "层级清晰", "cons": "空白略多" } ], "verdict": "选 B" }
```

## 7. 反馈怎么回到你手里

用户在预览窗口点「复制全部反馈」（单场景则「复制反馈」），grokbot-x 把反馈 JSON 加上所有附件一起放进剪贴板。用户粘回对话，你就收到 JSON + 附件。宿主自动补上来源信息（预览文件名、可取到的话带对话/消息号）和时间，你不用在页面里填。拿到后按验收项逐条处理，只处理用户填了的项。

## 8. 交付前自检

- [ ] zip 能双击独立打开，所有资源相对路径、无外网依赖、无需登录。
- [ ] 要验收的真实页面优先用 iframe + `?review=` 嵌入，正常访问（无参数）时逻辑不受影响。
- [ ] 每个场景的交互都真实可操作（动画进度条能拖、原型能走完、断点真会变）。
- [ ] 反馈 UI 由页面自己画，带「复制全部反馈」；无扩展时能「复制 JSON / 下载反馈」降级。
- [ ] 多场景用单页多 Tab，最后一次复制；JSON 每项带 `scene` 和 `verdict`。
- [ ] 包里和反馈里都没有凭据、令牌、会话或多余用户数据；不自动发送任何消息。
