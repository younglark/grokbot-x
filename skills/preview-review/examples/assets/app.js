(() => {
  const TABS = [
    { id: "visual", label: "视觉稿" },
    { id: "animation", label: "入场动画" },
    { id: "prototype", label: "交互走查" },
    { id: "responsive", label: "响应式" },
    { id: "general", label: "总评" }
  ];

  const state = {
    tab: "visual",
    visual: { verdict: null, regions: [], selected: null, note: "" },
    animation: { verdict: null, timeline: [], note: "" },
    prototype: {
      verdict: null,
      note: "",
      screen: "home",
      drink: null,
      size: "中杯",
      checklist: [
        { id: "open", label: "从首页进入某款咖啡详情", status: null, comment: "" },
        { id: "add", label: "选择规格并加入购物袋", status: null, comment: "" },
        { id: "checkout", label: "打开购物袋并结算", status: null, comment: "" },
        { id: "back", label: "返回路径是否清楚", status: null, comment: "" }
      ]
    },
    responsive: {
      verdict: null,
      note: "",
      current: "375",
      breakpoints: [
        { name: "375", label: "手机 375", verdict: null, note: "" },
        { name: "768", label: "平板 768", verdict: null, note: "" },
        { name: "1280", label: "桌面 1280", verdict: null, note: "" }
      ],
      collapsed: { "375": {}, "768": {}, "1280": {} },
      panelFold: { verdict: false, "375": false, "768": true, "1280": true, note: true }
    },
    general: { verdict: null, note: "" },
    files: []
  };


  const $ = (id) => document.getElementById(id);
  const tabsEl = $("tabs");
  const stageEl = $("stage");
  const panelEl = $("panelBody");

  let frameListener = null;
  function stopFrameListen() {
    if (frameListener) {
      window.removeEventListener("message", frameListener);
      frameListener = null;
    }
  }
  function listenFrame(handler) {
    stopFrameListen();
    frameListener = (ev) => {
      const data = ev.data;
      if (!data || data.type !== "preview-review") return;
      handler(data, ev.source);
    };
    window.addEventListener("message", frameListener);
  }
  function postFrame(payload) {
    const iframe = document.getElementById("reviewFrame");
    if (!iframe || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage(Object.assign({ type: "preview-review" }, payload), "*");
  }
  function frameHint(src, extra) {
    const bare = src.split("?")[0];
    return `<p class="hint">${extra || ""}嵌的是真实页面 <a href="${bare}" target="_blank" rel="noopener">${bare}</a>，带 <code>review</code> 参数才是验收模式，<a href="${bare}" target="_blank" rel="noopener">去掉参数</a>就是正常页面。</p>`;
  }
  function mountDeviceFrame(src, deviceClass, height) {
    const h = height || 560;
    return `<div class="device ${deviceClass}"><iframe id="reviewFrame" class="review-frame" title="被验收的真实页面" src="${src}" sandbox="allow-scripts allow-same-origin allow-forms" style="height:${h}px"></iframe></div>`;
  }


  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 2400);
  }

  function filledCount() {
    return TABS.filter((t) => {
      if (t.id === "responsive") {
        return state.responsive.breakpoints.every((b) => b.verdict) && state.responsive.verdict;
      }
      return !!state[t.id].verdict;
    }).length;
  }

  function tabStatus(id) {
    const s = state[id];
    if (id === "responsive") {
      const n = s.breakpoints.filter((b) => b.verdict).length;
      if (s.verdict && n === s.breakpoints.length) return "done";
      if (s.verdict || n) return "partial";
      return "";
    }
    if (s.verdict) return "done";
    if (id === "visual" && s.regions.length) return "partial";
    if (id === "animation" && s.timeline.length) return "partial";
    if (id === "prototype" && s.checklist.some((c) => c.status)) return "partial";
    return "";
  }

  function renderTabs() {
    tabsEl.innerHTML = "";
    TABS.forEach((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tab" + (tabStatus(t.id) ? " is-" + (tabStatus(t.id) === "done" ? "done" : "partial") : "");
      b.id = "tab-" + t.id;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(state.tab === t.id));
      b.innerHTML = `<span class="dot"></span>${t.label}`;
      b.addEventListener("click", () => selectTab(t.id));
      tabsEl.appendChild(b);
    });
    $("fillMeta").textContent = `已填 ${filledCount()} / ${TABS.length} 个场景`;
  }

  function choiceGroup(el, values, current, onChange) {
    el.innerHTML = "";
    values.forEach((v) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "choice";
      b.dataset.v = v;
      b.textContent = v;
      b.setAttribute("aria-pressed", String(v === current));
      b.addEventListener("click", () => onChange(v));
      el.appendChild(b);
    });
  }

  // Clean verdict control
  function bindVerdict(container, obj, key, after) {
    choiceGroup(container, ["通过", "需修改", "不通过"], obj[key], (v) => {
      obj[key] = v;
      bindVerdict(container, obj, key, after);
      renderTabs();
      after && after();
    });
  }

  function noteField(obj) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    wrap.innerHTML = `<label>备注</label><textarea placeholder="这一幕里需要改的地方"></textarea>`;
    const ta = wrap.querySelector("textarea");
    ta.value = obj.note || "";
    ta.addEventListener("input", () => { obj.note = ta.value; });
    return wrap;
  }

  /* ---------- visual ---------- */
  function syncVisualPins() {
    postFrame({ action: "setPins", pins: state.visual.regions, selected: state.visual.selected });
  }
  function renderVisualStage() {
    stageEl.innerHTML = mountDeviceFrame("app/main.html?review=visual", "phone") +
      frameHint("app/main.html", "在真实首页上点击打点，选中图钉后填写意见。可标多处。");
    listenFrame((msg) => {
      if (msg.action === "ready") syncVisualPins();
      if (msg.action === "annotate") {
        state.visual.regions.push({
          image: "home",
          screen: msg.screen || "home",
          x: +(+msg.x).toFixed(3),
          y: +(+msg.y).toFixed(3),
          comment: ""
        });
        state.visual.selected = state.visual.regions.length - 1;
        renderTabs();
        renderVisualPanel();
        syncVisualPins();
        panelEl.querySelector(`input[data-region="${state.visual.selected}"]`)?.focus();
      }
      if (msg.action === "selectPin") {
        state.visual.selected = msg.index;
        renderVisualPanel();
        syncVisualPins();
      }
    });
  }

  function renderVisualPanel() {
    const s = state.visual;
    panelEl.innerHTML = `<h2>视觉稿反馈</h2><div class="field"><label>结论</label><div class="choices" id="verdict"></div></div>
      <div class="field"><label>标注</label><div class="list" id="regions"></div></div>`;
    panelEl.appendChild(noteField(s));
    bindVerdict($("verdict"), s, "verdict");
    const list = $("regions");
    if (!s.regions.length) {
      list.innerHTML = `<div class="empty">还没有标注，点击左侧画面添加。</div>`;
    } else {
      s.regions.forEach((r, i) => {
        const item = document.createElement("div");
        item.className = "item";
        item.innerHTML = `<header><span>#${i + 1} · ${(r.x * 100).toFixed(0)}%, ${(r.y * 100).toFixed(0)}%</span>
          <button class="icon" type="button" data-del="${i}">删除</button></header>
          <input type="text" placeholder="这里有什么问题？" value="${escapeAttr(r.comment)}" data-region="${i}">`;
        list.appendChild(item);
      });
      list.querySelectorAll("input").forEach((inp) => {
        inp.addEventListener("input", () => { s.regions[+inp.dataset.region].comment = inp.value; });
        inp.addEventListener("focus", () => {
          s.selected = +inp.dataset.region;
          syncVisualPins();
        });
      });
      list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
        s.regions.splice(+b.dataset.del, 1);
        s.selected = null;
        renderTabs();
        renderVisualStage();
        renderVisualPanel();
      }));
    }
  }

  /* ---------- animation player ---------- */
  const DURATION = 1600;
  let clock = { t: 0, playing: false, rate: 1, raf: 0, last: 0, anims: [] };


  function applyClock() {
    clock.t = Math.max(0, Math.min(DURATION, clock.t));
    clock.anims.forEach((a) => {
      a.pause();
      a.currentTime = clock.t;
    });
    const p = clock.t / DURATION;
    const fill = document.getElementById("scrubFill");
    const thumb = document.getElementById("scrubThumb");
    const time = document.getElementById("timeLabel");
    const play = document.getElementById("playBtn");
    if (fill) fill.style.width = p * 100 + "%";
    if (thumb) thumb.style.left = p * 100 + "%";
    if (time) time.textContent = formatTime(clock.t) + " / " + formatTime(DURATION);
    if (play) play.setAttribute("aria-pressed", String(clock.playing));
    const icon = document.getElementById("playIcon");
    if (icon) icon.innerHTML = clock.playing
      ? `<rect x="4" y="3" width="3.5" height="10"/><rect x="9.5" y="3" width="3.5" height="10"/>`
      : `<path d="M4 3.2v9.6L13 8z"/>`;
    postFrame({ action: "seek", t: clock.t });
  }

  function formatTime(ms) {
    const s = ms / 1000;
    return s.toFixed(2) + "s";
  }

  function tick(now) {
    if (!clock.playing) return;
    if (!clock.last) clock.last = now;
    clock.t += (now - clock.last) * clock.rate;
    clock.last = now;
    if (clock.t >= DURATION) {
      clock.t = DURATION;
      clock.playing = false;
    }
    applyClock();
    if (clock.playing) clock.raf = requestAnimationFrame(tick);
  }

  function play() {
    if (clock.t >= DURATION) clock.t = 0;
    clock.playing = true;
    clock.last = 0;
    clock.raf = requestAnimationFrame(tick);
    applyClock();
  }
  function pause() {
    clock.playing = false;
    cancelAnimationFrame(clock.raf);
    applyClock();
  }
  function seekTo(t, { keepPlaying } = {}) {
    clock.t = t;
    if (!keepPlaying) pause();
    else applyClock();
  }

  function bindScrubber(root) {
    const scrub = root.querySelector(".scrub");
    let dragging = false;

    const posToTime = (ev) => {
      const rect = scrub.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      return p * DURATION;
    };

    const onDown = (ev) => {
      if (ev.target.closest(".mark")) return;
      ev.preventDefault();
      dragging = true;
      scrub.classList.add("dragging");
      try { scrub.setPointerCapture(ev.pointerId); } catch (_) {}
      seekTo(posToTime(ev));
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };
    const onMove = (ev) => {
      if (!dragging) return;
      ev.preventDefault();
      seekTo(posToTime(ev));
    };
    const onUp = (ev) => {
      if (!dragging) return;
      dragging = false;
      scrub.classList.remove("dragging");
      try { scrub.releasePointerCapture(ev.pointerId); } catch (_) {}
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    scrub.addEventListener("pointerdown", onDown);

    scrub.addEventListener("keydown", (ev) => {
      const step = ev.shiftKey ? 160 : 40;
      if (ev.key === "ArrowRight") { ev.preventDefault(); seekTo(clock.t + step); }
      if (ev.key === "ArrowLeft") { ev.preventDefault(); seekTo(clock.t - step); }
      if (ev.key === "Home") { ev.preventDefault(); seekTo(0); }
      if (ev.key === "End") { ev.preventDefault(); seekTo(DURATION); }
    });

    root.querySelector("#playBtn").addEventListener("click", () => {
      clock.playing ? pause() : play();
    });
    root.querySelectorAll("[data-rate]").forEach((b) => {
      b.addEventListener("click", () => {
        clock.rate = +b.dataset.rate;
        root.querySelectorAll("[data-rate]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      });
    });
    root.querySelector("#addCue").addEventListener("click", () => addCue(clock.t));
    scrub.addEventListener("dblclick", (ev) => {
      if (ev.target.closest(".mark")) return;
      addCue(posToTime(ev));
    });
  }

  function addCue(t) {
    const time = +((t / 1000).toFixed(3));
    state.animation.timeline.push({ t: time, frame: Math.round(time * 60), comment: "" });
    state.animation.timeline.sort((a, b) => a.t - b.t);
    renderTabs();
    renderMarks();
    renderAnimationPanel(false);
    const idx = state.animation.timeline.findIndex((c) => c.t === time);
    panelEl.querySelector(`input[data-cue="${idx}"]`)?.focus();
  }

  function renderMarks() {
    const box = document.getElementById("scrubMarks");
    if (!box) return;
    box.innerHTML = "";
    state.animation.timeline.forEach((c, i) => {
      const m = document.createElement("button");
      m.type = "button";
      m.className = "mark";
      m.style.left = (c.t / (DURATION / 1000)) * 100 + "%";
      m.title = `#${i + 1} ${c.t.toFixed(2)}s ${c.comment || ""}`;
      m.addEventListener("click", (ev) => {
        ev.stopPropagation();
        seekTo(c.t * 1000);
      });
      box.appendChild(m);
    });
  }

  function renderAnimationStage() {
    pause();
    clock.t = 0;
    clock.anims = [];
    stageEl.innerHTML = `
      <div class="player-wrap">
        <iframe id="reviewFrame" class="review-frame login-frame" title="登录页" src="app/login.html?review=1" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
        <div class="player" id="player">
          <div class="player-top">
            <button class="play" id="playBtn" type="button" aria-label="播放或暂停"><svg id="playIcon" viewBox="0 0 16 16"><path d="M4 3.2v9.6L13 8z"/></svg></button>
            <div class="time" id="timeLabel">0.00s / 1.60s</div>
            <div class="speeds">
              <button type="button" data-rate="0.4">0.4×</button>
              <button type="button" data-rate="1" aria-pressed="true">1×</button>
              <button type="button" data-rate="1.8">1.8×</button>
            </div>
          </div>
          <div class="scrub" id="scrub" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="${DURATION}" aria-label="动画进度，可拖动">
            <div class="scrub-track"></div>
            <div class="scrub-fill" id="scrubFill"></div>
            <div class="scrub-marks" id="scrubMarks"></div>
            <div class="scrub-thumb" id="scrubThumb"></div>
          </div>
          <p class="player-hint">拖动进度条预览任意时刻；双击进度条或点下方按钮，在当前时刻添加评论。</p>
          <button class="ghost add-cue" id="addCue" type="button">在此刻添加评论</button>
        </div>
      </div>
      ${frameHint("app/login.html", "空格键播放 / 暂停，方向键微调时间。")}`;
    bindScrubber(stageEl);
    renderMarks();
    applyClock();
    listenFrame((msg) => {
      if (msg.action === "ready") play();
    });
  }

  function renderAnimationPanel(full = true) {
    if (!full && panelEl.dataset.scene === "animation") {
      syncCueList();
      return;
    }
    const s = state.animation;
    panelEl.dataset.scene = "animation";
    panelEl.innerHTML = `<h2>动画反馈</h2><div class="field"><label>结论</label><div class="choices" id="verdict"></div></div>
      <div class="field"><label>时间轴评论</label><div class="list" id="cues"></div></div>`;
    panelEl.appendChild(noteField(s));
    bindVerdict($("verdict"), s, "verdict");
    syncCueList();
  }

  function syncCueList() {
    const list = $("cues");
    if (!list) return;
    const s = state.animation;
    if (!s.timeline.length) {
      list.innerHTML = `<div class="empty">还没有帧评论。播放到出问题的时刻再添加。</div>`;
      return;
    }
    list.innerHTML = "";
    s.timeline.forEach((c, i) => {
      const item = document.createElement("div");
      item.className = "item";
      item.innerHTML = `<header><span>#${i + 1} · ${c.t.toFixed(2)}s</span>
        <span><button class="icon" type="button" data-jump="${i}">跳转</button>
        <button class="icon" type="button" data-del="${i}">删除</button></span></header>
        <input type="text" placeholder="这一刻有什么问题？" value="${escapeAttr(c.comment)}" data-cue="${i}">`;
      list.appendChild(item);
    });
    list.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("input", () => { s.timeline[+inp.dataset.cue].comment = inp.value; });
    });
    list.querySelectorAll("[data-jump]").forEach((b) => b.addEventListener("click", () => {
      seekTo(s.timeline[+b.dataset.jump].t * 1000);
    }));
    list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
      s.timeline.splice(+b.dataset.del, 1);
      renderTabs();
      renderMarks();
      syncCueList();
    }));
  }

  /* ---------- prototype ---------- */
  function renderPrototypeStage() {
    const s = state.prototype;
    const hash = s.screen === "cart" ? "#/cart" : s.screen === "detail" ? `#/detail/${s.drink || "dirty"}` : "#/";
    stageEl.innerHTML = mountDeviceFrame("app/main.html?review=1" + hash, "phone") +
      frameHint("app/main.html", "请亲手走一遍真实页面：点一杯咖啡、选规格、加入购物袋并结算。按走查项记录卡住或有问题的步骤。");
    listenFrame((msg) => {
      if (msg.action === "navigate") {
        s.screen = msg.screen || s.screen;
        if (msg.drink) s.drink = msg.drink;
        if (msg.size) s.size = msg.size;
      }
    });
  }

  function renderPrototypePanel() {
    const s = state.prototype;
    panelEl.dataset.scene = "prototype";
    panelEl.innerHTML = `<h2>交互走查</h2><div class="field"><label>结论</label><div class="choices" id="verdict"></div></div>
      <div class="field"><label>走查清单</label><div class="list" id="checks"></div></div>`;
    panelEl.appendChild(noteField(s));
    bindVerdict($("verdict"), s, "verdict");
    const list = $("checks");
    s.checklist.forEach((c, i) => {
      const item = document.createElement("div");
      item.className = "item";
      item.innerHTML = `<header><span>${c.label}</span></header>
        <div class="choices" data-check="${i}"></div>
        <input type="text" placeholder="可选说明" value="${escapeAttr(c.comment || "")}" data-cmt="${i}">`;
      list.appendChild(item);
      const map = { pass: "通过", stuck: "卡住", issue: "有问题" };
      const labels = ["通过", "卡住", "有问题"];
      const rev = { "通过": "pass", "卡住": "stuck", "有问题": "issue" };
      const box = item.querySelector(".choices");
      const bindCheck = (current) => choiceGroup(box, labels, current, (v) => {
        s.checklist[i].status = rev[v];
        renderTabs();
        bindCheck(v);
      });
      bindCheck(c.status ? map[c.status] : null);
      item.querySelector("input").addEventListener("input", (e) => { c.comment = e.target.value; });
    });
  }


  function regionOpen(bp, id) {
    return !state.responsive.collapsed[bp]?.[id];
  }
  function syncRegionChips(bp) {
    document.querySelectorAll(".region-chip").forEach((b, i) => {
      const ids = regionIds(bp);
      if (ids[i]) b.setAttribute("aria-pressed", String(regionOpen(bp, ids[i][0])));
    });
  }
  function toggleRegion(bp, id) {
    const map = state.responsive.collapsed[bp] || (state.responsive.collapsed[bp] = {});
    map[id] = !map[id];
    if (document.getElementById("reviewFrame") && state.tab === "responsive") {
      postFrame({ action: "setFold", collapsed: map });
      syncRegionChips(bp);
      return;
    }
    renderResponsiveStage();
  }
  function regionIds(bp) {
    return bp === "1280"
      ? [["side", "侧栏"], ["hero", "主视觉"], ["list", "商品栅格"]]
      : [["nav", "顶栏"], ["chips", "分类"], ["hero", "精选"], ["list", "饮品列表"], ["tabbar", "底栏"]];
  }
  function setAllRegions(bp, collapsed) {
    state.responsive.collapsed[bp] = Object.fromEntries(regionIds(bp).map(([id]) => [id, collapsed]));
    if (document.getElementById("reviewFrame") && state.tab === "responsive") {
      postFrame({ action: "setFold", collapsed: state.responsive.collapsed[bp] });
      syncRegionChips(bp);
      return;
    }
    renderResponsiveStage();
  }
  function focusBreakpoint(name) {
    const s = state.responsive;
    s.current = name;
    s.breakpoints.forEach((b) => { s.panelFold[b.name] = b.name !== name; });
    s.panelFold[name] = false;
    if (document.getElementById("reviewFrame") && state.tab === "responsive") {
      applyResponsiveChrome();
      renderResponsivePanel();
      renderTabs();
      return;
    }
    renderResponsiveStage();
    renderResponsivePanel();
  }
  function bindRegionToggles(bp) {
    const host = $("regionToggles");
    if (host) {
      regionIds(bp).forEach(([id, label]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "region-chip";
        b.textContent = label;
        b.setAttribute("aria-pressed", String(regionOpen(bp, id)));
        b.addEventListener("click", () => toggleRegion(bp, id));
        host.appendChild(b);
      });
    }
    const openAll = stageEl.querySelector("[data-regions='open']");
    const closeAll = stageEl.querySelector("[data-regions='close']");
    if (openAll && !openAll.dataset.bound) {
      openAll.dataset.bound = "1";
      openAll.addEventListener("click", () => setAllRegions(state.responsive.current, false));
    }
    if (closeAll && !closeAll.dataset.bound) {
      closeAll.dataset.bound = "1";
      closeAll.addEventListener("click", () => setAllRegions(state.responsive.current, true));
    }
  }
  function regionToolbar() {
    return `<div class="stage-tools">
      <div class="bp-switch" id="bpSwitch"></div>
      <div class="region-actions">
        <div class="region-toggles" id="regionToggles"></div>
        <span class="sep">·</span>
        <button type="button" class="text-btn" data-regions="open">全部展开</button>
        <span class="sep">·</span>
        <button type="button" class="text-btn" data-regions="close">全部收起</button>
      </div>
    </div>`;
  }

  /* ---------- responsive ---------- */
  function deviceClassFor(bp) {
    return bp === "1280" ? "desktop" : bp === "768" ? "tablet" : "phone";
  }
  function applyResponsiveChrome() {
    const cur = state.responsive.current;
    const wrap = stageEl.querySelector(".device");
    const iframe = document.getElementById("reviewFrame");
    if (wrap) wrap.className = "device " + deviceClassFor(cur);
    if (iframe) iframe.style.height = (cur === "1280" ? 520 : 560) + "px";
    const sw = $("bpSwitch");
    if (sw) {
      sw.innerHTML = "";
      state.responsive.breakpoints.forEach((bp) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ghost";
        b.textContent = bp.label;
        b.setAttribute("aria-pressed", String(bp.name === cur));
        if (bp.name === cur) { b.style.background = "var(--ink)"; b.style.color = "#fff"; b.style.borderColor = "var(--ink)"; }
        b.addEventListener("click", () => focusBreakpoint(bp.name));
        sw.appendChild(b);
      });
    }
    const host = $("regionToggles");
    if (host) {
      host.innerHTML = "";
      bindRegionToggles(cur);
    }
    postFrame({ action: "setFold", collapsed: state.responsive.collapsed[cur] || {} });
  }
  function renderResponsiveStage() {
    const cur = state.responsive.current;
    stageEl.innerHTML = `
      ${regionToolbar()}
      ${mountDeviceFrame("app/main.html?review=1", deviceClassFor(cur), cur === "1280" ? 520 : 560)}
      ${frameHint("app/main.html", "切换断点时 iframe 只改变宽度，真实页面用媒体查询响应。用上方分区开关可折叠同一块。")}`;
    applyResponsiveChrome();
    listenFrame((msg) => {
      if (msg.action === "ready") postFrame({ action: "setFold", collapsed: state.responsive.collapsed[state.responsive.current] || {} });
      if (msg.action === "toggleFold") toggleRegion(state.responsive.current, msg.id);
    });
  }

  function foldOpen(key) {
    return !state.responsive.panelFold[key];
  }
  function appendFold(parent, key, title, meta, buildBody) {
    const open = foldOpen(key);
    const sec = document.createElement("section");
    sec.className = "fold" + (open ? " is-open" : "");
    const bar = document.createElement("button");
    bar.type = "button";
    bar.className = "fold-bar";
    bar.setAttribute("aria-expanded", String(open));
    bar.innerHTML = `<i class="chev" aria-hidden="true"></i><span>${title}</span>${meta ? `<em class="fold-meta">${meta}</em>` : ""}`;
    bar.addEventListener("click", () => {
      state.responsive.panelFold[key] = !state.responsive.panelFold[key];
      renderResponsivePanel();
    });
    const body = document.createElement("div");
    body.className = "fold-body";
    sec.appendChild(bar);
    sec.appendChild(body);
    parent.appendChild(sec);
    if (buildBody) buildBody(body);
    return body;
  }
  function renderResponsivePanel() {
    const s = state.responsive;
    panelEl.dataset.scene = "responsive";
    panelEl.innerHTML = `<h2>响应式反馈</h2>`;
    appendFold(panelEl, "verdict", "总结论", s.verdict || "", (body) => {
      const box = document.createElement("div");
      box.className = "choices";
      box.id = "verdict";
      body.appendChild(box);
      bindVerdict(box, s, "verdict", () => renderResponsivePanel());
    });
    s.breakpoints.forEach((bp, i) => {
      const meta = [bp.verdict, bp.name === s.current ? "当前" : ""].filter(Boolean).join(" · ");
      appendFold(panelEl, bp.name, bp.label, meta, (body) => {
        if (bp.name !== s.current) {
          const tools = document.createElement("div");
          tools.className = "fold-tools";
          const show = document.createElement("button");
          show.type = "button";
          show.className = "text-btn";
          show.textContent = "在预览中查看";
          show.addEventListener("click", () => focusBreakpoint(bp.name));
          tools.appendChild(show);
          body.appendChild(tools);
        }
        const choices = document.createElement("div");
        choices.className = "choices";
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = "这个尺寸下的问题";
        input.value = bp.note || "";
        input.addEventListener("input", (e) => { bp.note = e.target.value; });
        body.appendChild(choices);
        body.appendChild(input);
        bindVerdict(choices, bp, "verdict", () => {
          renderTabs();
          renderResponsivePanel();
        });
      });
    });
    appendFold(panelEl, "note", "备注", s.note ? "已填" : "", (body) => {
      const ta = document.createElement("textarea");
      ta.placeholder = "这一幕里需要改的地方";
      ta.value = s.note || "";
      ta.addEventListener("input", () => { s.note = ta.value; });
      body.appendChild(ta);
    });
  }

  /* ---------- general ---------- */
  function renderGeneralStage() {
    stageEl.innerHTML = `
      <div class="login" style="max-width:440px">
        <h2>总评</h2>
        <p class="sub">前面几个场景看完后，在这里给一个整体判断。也可以只写跨场景的问题，例如品牌语气是否一致、动效是否和视觉冲突。</p>
      </div>
      <p class="hint">本页的附件区在底部，截图和录屏会随「复制全部反馈」一起带走。</p>`;
  }
  function renderGeneralPanel() {
    const s = state.general;
    panelEl.dataset.scene = "general";
    panelEl.innerHTML = `<h2>整体结论</h2><div class="field"><label>结论</label><div class="choices" id="verdict"></div></div>`;
    panelEl.appendChild(noteField(s));
    bindVerdict($("verdict"), s, "verdict");
  }

  /* ---------- routing ---------- */
  const renders = {
    visual: [renderVisualStage, renderVisualPanel],
    animation: [renderAnimationStage, renderAnimationPanel],
    prototype: [renderPrototypeStage, renderPrototypePanel],
    responsive: [renderResponsiveStage, renderResponsivePanel],
    general: [renderGeneralStage, renderGeneralPanel]
  };

  function selectTab(id) {
    if (state.tab === "animation" && id !== "animation") pause();
    stopFrameListen();
    state.tab = id;
    location.hash = id;
    panelEl.dataset.scene = id;
    renderTabs();
    renders[id][0]();
    renders[id][1]();
  }

  function escapeAttr(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function collectPayload() {
    return {
      v: 1,
      title: "晨光咖啡 App 改版验收",
      scene: "bundle",
      tabs: {
        visual: {
          scene: "visual",
          verdict: state.visual.verdict,
          regions: state.visual.regions.map((r, i) => ({ ...r, index: i + 1 })),
          note: state.visual.note.trim()
        },
        animation: {
          scene: "animation",
          verdict: state.animation.verdict,
          timeline: state.animation.timeline,
          note: state.animation.note.trim()
        },
        prototype: {
          scene: "prototype",
          verdict: state.prototype.verdict,
          checklist: state.prototype.checklist,
          note: state.prototype.note.trim()
        },
        responsive: {
          scene: "responsive",
          verdict: state.responsive.verdict,
          breakpoints: state.responsive.breakpoints.map((b) => ({
            name: b.name, label: b.label, verdict: b.verdict, note: (b.note || "").trim()
          })),
          note: state.responsive.note.trim()
        },
        general: {
          scene: "general",
          verdict: state.general.verdict,
          note: state.general.note.trim()
        }
      },
      filled: filledCount(),
      total: TABS.length
    };
  }

  async function copyAll() {
    const payload = collectPayload();
    const files = $("files").files ? Array.from($("files").files) : [];
    const bridge = window.__grokbotXPreview;
    if (bridge && bridge.submitFeedback) {
      await bridge.submitFeedback({ json: payload, files });
      toast("已交给 grokbot-x，请粘贴回对话");
      return;
    }
    const text = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      toast(files.length ? "已复制全部反馈 JSON（无扩展降级，附件请自行附上）" : "已复制全部反馈 JSON");
    } catch {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      a.download = "feedback.json";
      a.click();
      toast("已下载 feedback.json");
    }
  }

  function setShellFold(which, collapsed) {
    if (which === "panel") {
      $("main").classList.toggle("is-panel-collapsed", collapsed);
      const btn = $("togglePanel");
      btn.setAttribute("aria-expanded", String(!collapsed));
      btn.textContent = collapsed ? "展开验收" : "收起验收";
    } else {
      document.querySelector(".app").classList.toggle("is-top-collapsed", collapsed);
      const btn = $("toggleTop");
      btn.setAttribute("aria-expanded", String(!collapsed));
      btn.textContent = collapsed ? "展开顶栏" : "收起顶栏";
    }
  }

  function bindGlobal() {
    $("togglePanel").addEventListener("click", () => {
      setShellFold("panel", !$("main").classList.contains("is-panel-collapsed"));
    });
    $("toggleTop").addEventListener("click", () => {
      setShellFold("top", !document.querySelector(".app").classList.contains("is-top-collapsed"));
    });
    $("copyAll").addEventListener("click", copyAll);
    $("files").addEventListener("change", () => {
      const n = Array.from($("files").files || []);
      $("fileHint").textContent = n.length ? n.map((f) => f.name).join("、") : "可附截图、录屏或其他文件";
    });
    window.addEventListener("keydown", (ev) => {
      if (state.tab !== "animation") return;
      const tag = ev.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (ev.key === " ") { ev.preventDefault(); clock.playing ? pause() : play(); }
    });
    window.addEventListener("hashchange", () => {
      const id = location.hash.slice(1);
      if (TABS.some((t) => t.id === id) && id !== state.tab) selectTab(id);
    });
  }


  function applyPreviewParams() {
    const q = new URLSearchParams(location.search);
    const bp = q.get("bp");
    if (bp && state.responsive.breakpoints.some((b) => b.name === bp)) {
      state.responsive.current = bp;
      state.responsive.breakpoints.forEach((b) => { state.responsive.panelFold[b.name] = b.name !== bp; });
    }
    const fold = q.get("fold");
    if (fold) {
      const cur = state.responsive.current;
      const all = regionIds(cur).map(([id]) => id);
      const ids = fold === "all" ? all : fold.split(",").map((s) => s.trim()).filter((id) => all.includes(id));
      state.responsive.collapsed[cur] = Object.fromEntries(ids.map((id) => [id, true]));
    }
    const shell = (q.get("shell") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (shell.includes("panel") || shell.includes("top")) {
      // applied after bindGlobal so buttons exist
      state._shell = shell;
    }
  }
  function init() {
    bindGlobal();
    applyPreviewParams();
    if (state._shell) {
      if (state._shell.includes("panel")) setShellFold("panel", true);
      if (state._shell.includes("top")) setShellFold("top", true);
    }
    const id = location.hash.slice(1);
    selectTab(TABS.some((t) => t.id === id) ? id : "visual");
    if (new URLSearchParams(location.search).get("test") === "scrub") {
      setTimeout(runScrubTest, 400);
    }
  }

  function runScrubTest() {
    pause();
    const scrub = document.getElementById("scrub");
    const rect = scrub.getBoundingClientRect();
    const fire = (type, x) => {
      scrub.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: rect.top + 14,
        pointerId: 1, pointerType: "mouse", buttons: type === "pointerup" ? 0 : 1
      }));
    };
    const x0 = rect.left + rect.width * 0.2;
    const x1 = rect.left + rect.width * 0.75;
    fire("pointerdown", x0);
    fire("pointermove", x1);
    fire("pointerup", x1);
    const expected = 0.75 * DURATION;
    const ok = Math.abs(clock.t - expected) < 40;
    const result = { ok, t: Math.round(clock.t), expected: Math.round(expected) };
    document.title = "SCRUB:" + JSON.stringify(result);
    const el = document.createElement("pre");
    el.id = "test-result";
    el.textContent = document.title;
    document.body.appendChild(el);
  }

  init();
})();
