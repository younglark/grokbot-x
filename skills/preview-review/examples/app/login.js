(() => {
  const DURATION = 1600;
  const form = document.getElementById("loginForm");
  const review = window.PreviewReview || { enabled: false, onCommand() {}, send() {} };

  function fadeUp(el, delay, dur, extraTo) {
    const to = Object.assign({ opacity: 1, transform: "translateY(0)" }, extraTo || {});
    const a = el.animate(
      [{ opacity: 0, transform: extraTo && extraTo.transform ? "translateY(18px) scale(.96)" : "translateY(16px)" }, to],
      { duration: dur, delay, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" }
    );
    if (review.enabled) a.pause();
    return a;
  }

  const anims = [];
  anims.push(fadeUp(form, 0, 800));
  anims.push(fadeUp(form.querySelector("h2"), 180, 600));
  anims.push(fadeUp(form.querySelector(".sub"), 260, 600));
  form.querySelectorAll(".fieldline").forEach((el, i) => anims.push(fadeUp(el, 420 + i * 90, 550)));
  const btn = form.querySelector(".login-btn");
  const ba = btn.animate(
    [
      { opacity: 0, transform: "translateY(18px) scale(.96)" },
      { opacity: 1, transform: "translateY(0) scale(1)" }
    ],
    { duration: 800, delay: 780, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" }
  );
  if (review.enabled) ba.pause();
  anims.push(ba);

  function apply(t) {
    const ms = Math.max(0, Math.min(DURATION, t));
    anims.forEach((a) => {
      a.pause();
      a.currentTime = ms;
    });
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    form.classList.add("is-ok");
  });

  if (review.enabled) {
    apply(0);
    review.send({ action: "ready", duration: DURATION, page: "login" });
    review.onCommand((msg) => {
      if (msg.action === "seek") apply(msg.t);
    });
  }
})();
