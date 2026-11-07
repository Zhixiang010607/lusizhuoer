/* Phone-only editorial motion, independent of employee sessions and native APIs. */
(() => {
  "use strict";
  const motion = document.getElementById("projectMotion");
  const story = document.querySelector(".public-project-story");
  const tabs = [...document.querySelectorAll("[data-chapter]")];
  const progress = document.querySelector(".project-phone-track span");
  let reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function applyMotion() {
    document.body.classList.toggle("project-motion-off", reduce);
    motion.textContent = reduce ? "开启动效" : "关闭动效";
    motion.setAttribute("aria-pressed", String(!reduce));
  }
  function markChapter() {
    const selected = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
    story.dataset.activeChapter = String(selected);
    document.getElementById("projectChapterNumber").textContent = `0${selected + 1} / 03`;
  }
  motion.addEventListener("click", () => { reduce = !reduce; applyMotion(); });
  tabs.forEach((tab) => {
    tab.addEventListener("click", markChapter);
    tab.addEventListener("keydown", markChapter);
  });
  let frame;
  window.addEventListener("scroll", () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const available = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.width = `${available > 0 ? Math.min(100, window.scrollY / available * 100) : 0}%`;
    });
  }, { passive: true });
  markChapter();
  applyMotion();
})();
