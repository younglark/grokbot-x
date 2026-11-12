(() => {
  const review = window.PreviewReview || { enabled: false, mode: null, params: new URLSearchParams(), onCommand() {}, send() {} };

  const DRINKS = [
    { id: "dirty", name: "燕麦 Dirty", desc: "埃塞俄比亚日晒豆", price: 16, thumb: "t1", featured: true },
    { id: "osmanthus", name: "桂花酿拿铁", desc: "热 / 冰", price: 28, thumb: "t1" },
    { id: "gesha", name: "瑰夏手冲", desc: "浅烘 · 单品", price: 48, thumb: "t2" },
    { id: "basque", name: "抹茶巴斯克", desc: "当日限量", price: 32, thumb: "t3" }
  ];

  const state = {
    screen: "home",
    drink: "dirty",
    size: "中杯",
    folded: {},
    pins: [],
    selected: null
  };

  function drinkById(id) {
    return DRINKS.find((d) => d.id === id) || DRINKS[0];
  }

  function region(id, label, inner, extra) {
    const collapsed = !!state.folded[id];
    return `<section class="region${collapsed ? " is-collapsed" : ""}${extra ? " " + extra : ""}" data-region="${id}">
      <button type="button" class="region-bar" data-toggle="${id}">${label}</button>
      <div class="region-body">${inner}</div>
    </section>`;
  }

  function listRows() {
    return DRINKS.filter((d) => !d.featured).map((d) => `
      <a class="row" href="#/detail/${d.id}">
        <div class="thumb ${d.thumb}"></div>
        <div class="meta"><b>${d.name}</b><span>${d.desc}</span></div>
        <div class="price">${d.price}</div>
      </a>`).join("");
  }

  function homeHTML() {
    const featured = DRINKS[0];
    return `
      ${region("side", "侧栏", `<aside class="web-side"><h3>晨光咖啡</h3><a class="on" href="#/">发现</a><a href="#/">菜单</a><a href="#/">门店</a><a href="#/">我的</a></aside>`, "region-side desk-only")}
      ${region("nav", "顶栏", `
        <div class="status"><span>9:41</span><span>晨光咖啡</span></div>
        <div class="nav"><h3>发现</h3><span class="loc">上海 · 静安</span></div>`, "mob-only")}
      ${region("chips", "分类", `
        <div class="chips">
          <button class="chip on" type="button">精选</button>
          <button class="chip" type="button">拿铁</button>
          <button class="chip" type="button">手冲</button>
          <button class="chip" type="button">甜品</button>
        </div>`, "mob-only")}
      ${region("hero", "精选", `
        <a class="hero desk-hide web-hero-slot" href="#/detail/${featured.id}">
          <small>今日精选</small><h4>${featured.name}</h4>
          <small>${featured.desc} · ${featured.price} 元</small>
        </a>`)}
      ${region("list", "饮品列表", `
        <div class="rows mob-only">${listRows()}</div>
        <div class="web-grid desk-only">${DRINKS.filter((d) => !d.featured).map((d) =>
          `<a class="web-card" href="#/detail/${d.id}"><b>${d.name}</b><div class="empty">${d.desc} · ¥${d.price}</div></a>`
        ).join("")}</div>`, "grow")}
      ${region("tabbar", "底栏", `<div class="tabbar"><span class="on">发现</span><span>菜单</span><span>门店</span><span>我的</span></div>`, "region-dock mob-only")}`;
  }

  function detailHTML() {
    const drink = drinkById(state.drink);
    const sizes = ["小杯", "中杯", "大杯"].map((s) =>
      `<button class="chip${s === state.size ? " on" : ""}" type="button" data-size="${s}">${s}</button>`
    ).join("");
    return `
      <div class="status mob-only"><span>9:41</span><span>晨光咖啡</span></div>
      <div class="detail">
        <a class="back" href="#/">← 发现</a>
        <div class="hero"><small>${drink.desc}</small><h4>${drink.name}</h4></div>
        <h3>${drink.name}</h3>
        <p class="lead">${drink.desc}。可按口感选择杯型。</p>
        <div class="sizes">${sizes}</div>
        <div class="cta-block"><a class="cta" href="#/cart">加入购物袋 · ¥${drink.price}</a></div>
      </div>
      <div class="tabbar mob-only"><span class="on">发现</span><span>菜单</span><span>门店</span><span>我的</span></div>`;
  }

  function cartHTML() {
    const drink = drinkById(state.drink);
    return `
      <div class="status mob-only"><span>9:41</span><span>晨光咖啡</span></div>
      <div class="cart">
        <a class="back" href="#/detail/${drink.id}">← 返回</a>
        <h3>购物袋</h3>
        <div class="cart-item"><div><b>${drink.name}</b><div class="empty">${state.size} × 1</div></div><div>¥${drink.price}</div></div>
        <div class="cart-item"><b>合计</b><b>¥${drink.price}</b></div>
        <div class="cta-block" style="margin-top:16px"><button class="cta" type="button" data-pay="1">去结算</button></div>
      </div>
      <div class="tabbar mob-only"><span>发现</span><span class="on">菜单</span><span>门店</span><span>我的</span></div>`;
  }

  function parseHash() {
    const h = (location.hash || "#/").replace(/^#/, "");
    const parts = h.split("/").filter(Boolean);
    if (parts[0] === "detail" && parts[1]) return { screen: "detail", drink: parts[1] };
    if (parts[0] === "cart") return { screen: "cart" };
    return { screen: "home" };
  }

  function render() {
    const route = parseHash();
    state.screen = route.screen;
    if (route.drink) state.drink = route.drink;
    const app = document.getElementById("app");
    if (state.screen === "detail") app.innerHTML = detailHTML();
    else if (state.screen === "cart") app.innerHTML = cartHTML();
    else app.innerHTML = homeHTML();
    drawPins();
    review.send({ action: "navigate", screen: state.screen, drink: state.drink, size: state.size });
  }

  function applyFold(map) {
    state.folded = map || {};
    document.querySelectorAll("[data-region]").forEach((el) => {
      el.classList.toggle("is-collapsed", !!state.folded[el.dataset.region]);
    });
  }

  function drawPins() {
    const layer = document.getElementById("pins");
    if (!layer) return;
    const visible = review.mode === "visual";
    layer.hidden = !visible;
    layer.innerHTML = "";
    if (!visible) return;
    state.pins.forEach((p, i) => {
      if ((p.screen || "home") !== state.screen) return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pin" + (state.selected === i ? " active" : "");
      b.style.left = p.x * 100 + "%";
      b.style.top = p.y * 100 + "%";
      b.dataset.pin = String(i);
      b.innerHTML = `<span>${i + 1}</span>`;
      layer.appendChild(b);
    });
  }

  document.addEventListener("click", (ev) => {
    const toggle = ev.target.closest("[data-toggle]");
    if (toggle && review.enabled) {
      ev.preventDefault();
      review.send({ action: "toggleFold", id: toggle.dataset.toggle });
      return;
    }
    const size = ev.target.closest("[data-size]");
    if (size) {
      ev.preventDefault();
      state.size = size.dataset.size;
      render();
      return;
    }
    const pay = ev.target.closest("[data-pay]");
    if (pay) {
      ev.preventDefault();
      pay.textContent = "这是示例，结算到此为止";
      return;
    }
    if (review.mode === "visual") {
      const pin = ev.target.closest("[data-pin]");
      if (pin) {
        ev.preventDefault();
        ev.stopPropagation();
        review.send({ action: "selectPin", index: +pin.dataset.pin });
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      const x = ev.clientX / window.innerWidth;
      const y = ev.clientY / window.innerHeight;
      review.send({ action: "annotate", x, y, screen: state.screen });
    }
  }, true);

  window.addEventListener("hashchange", render);

  if (review.enabled) {
    document.documentElement.classList.add("is-review");
    const fold = (review.params.get("fold") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (fold.length) state.folded = Object.fromEntries(fold.map((id) => [id, true]));
    review.onCommand((msg) => {
      if (msg.action === "setFold") applyFold(msg.collapsed);
      if (msg.action === "setPins") {
        state.pins = msg.pins || [];
        state.selected = msg.selected;
        drawPins();
      }
      if (msg.action === "goto" && msg.hash) location.hash = msg.hash;
    });
    review.send({ action: "ready", page: "main", screen: parseHash().screen });
  }

  render();
})();
