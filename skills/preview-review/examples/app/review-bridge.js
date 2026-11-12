/* 真实页面用的验收桥：只有带 review 参数时才工作，不影响正常逻辑。 */
(() => {
  const params = new URLSearchParams(location.search);
  const mode = params.get("review"); // "1" | "visual" | null
  const enabled = !!mode;

  function send(payload) {
    if (!enabled || window.parent === window) return;
    window.parent.postMessage(Object.assign({ type: "preview-review" }, payload), "*");
  }

  function onCommand(handler) {
    if (!enabled) return;
    window.addEventListener("message", (ev) => {
      const data = ev.data;
      if (!data || data.type !== "preview-review") return;
      handler(data);
    });
  }

  window.PreviewReview = { enabled, mode, params, send, onCommand };
  if (enabled) document.documentElement.classList.add("is-review");
  if (mode === "visual") document.documentElement.classList.add("is-annotate");
})();
