/* grokbot-x page runtime. Injected once per document before feature scripts.
 * Exposes window.__grokbotX with a tiny registry and a send() that forwards
 * {v, feature, type, data} to the daemon through a CDP binding. */
(() => {
  if (window.__grokbotX && window.__grokbotX.v === 1) return;
  const BINDING = '__GROKBOTX_BINDING__';
  const features = new Set();
  const api = {
    v: 1,
    register(name) {
      if (features.has(name)) return false;
      features.add(name);
      return true;
    },
    has(name) { return features.has(name); },
    send(feature, type, data) {
      const fn = window[BINDING];
      if (typeof fn !== 'function') return false;
      try {
        fn(JSON.stringify({ v: 1, feature: String(feature), type: String(type), data: data ?? null }));
        return true;
      } catch {
        return false;
      }
    },
  };
  Object.defineProperty(window, '__grokbotX', { value: Object.freeze(api), configurable: false, writable: false });
})();
