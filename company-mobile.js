/* Web-native phone presentation. Public copy stays in the Web HTML. */
(() => {
  "use strict";
  const phone = window.matchMedia("(max-width: 650px)");
  const body = document.body;
  const scroller = document.querySelector(".company-content");
  const slides = [...document.querySelectorAll(".company-section[data-company-section]")];
  if (!scroller || slides.length !== 6) return;
  let observer;
  let active = 0;
  let scrollFrame = 0;
  let navigationFrame = 0;
  let navigating = false;
  slides.forEach((slide) => {
    const copy = document.createElement("div");
    copy.className = "company-slide-copy";
    copy.append(...slide.childNodes);
    slide.append(copy);
  });
  const top = document.createElement("header");
  top.className = "company-phone-top";
  top.innerHTML = '<a href="#overview" aria-label="返回公司首屏">露思卓儿</a><a href="#login">登录</a>';
  const footer = document.createElement("nav");
  footer.className = "company-phone-footer";
  footer.setAttribute("aria-label", "公司介绍翻页");
  footer.innerHTML = '<span class="company-phone-number"></span><a class="company-phone-next" href="#about">上滑继续 ↑</a>';
  const track = document.createElement("div");
  track.className = "company-phone-progress";
  track.setAttribute("aria-hidden", "true");
  track.innerHTML = "<span></span>";
  body.append(top, footer, track);

  function mark(index) {
    active = index;
    slides.forEach((slide, i) => slide.classList.toggle("phone-slide-active", i === index));
    top.classList.toggle("visible", index > 0);
    footer.querySelector(".company-phone-number").textContent = `0${index + 1} / 06`;
    const next = footer.querySelector(".company-phone-next");
    next.href = `#${slides[index === 5 ? 0 : index + 1].dataset.companySection}`;
    next.textContent = index === 5 ? "回到首屏 ↑" : "上滑继续 ↑";
    track.firstElementChild.style.width = `${index / 5 * 100}%`;
  }
  function visibleSlide() {
    if (navigating || !body.classList.contains("company-phone-slides")) return;
    const center = scroller.scrollTop + scroller.clientHeight / 2;
    let closest = 0;
    slides.forEach((slide, i) => { if (slide.offsetTop <= center) closest = i; });
    if (closest === active) return;
    mark(closest);
    // Replacing the hash preserves a single Back step out of the presentation.
    history.replaceState(null, "", `#${slides[closest].dataset.companySection}`);
  }
  function sync() {
    observer?.disconnect();
    cancelAnimationFrame(navigationFrame);
    cancelAnimationFrame(scrollFrame);
    navigating = false;
    const params = new URLSearchParams(location.search);
    const key = location.hash.slice(1) || (params.has("reason") || params.get("mode") === "reset" ? "login" : "overview");
    const useSlides = phone.matches && key !== "login";
    body.classList.toggle("company-phone-slides", useSlides);
    body.classList.toggle("company-phone-login", phone.matches && key === "login");
    if (!phone.matches) return;
    if (!useSlides) {
      scroller.scrollTop = 0;
      return;
    }
    navigating = true;
    cancelAnimationFrame(scrollFrame);
    slides.forEach((slide) => { slide.hidden = false; });
    const index = Math.max(0, slides.findIndex((slide) => slide.dataset.companySection === key));
    mark(index);
    scroller.scrollTop = slides[index].offsetTop;
    cancelAnimationFrame(navigationFrame);
    navigationFrame = requestAnimationFrame(() => {
      navigating = false;
      // Native scrolling handles touch, trackpad and keyboards, including short screens.
      observer = new ResizeObserver(() => { scroller.scrollTop = slides[active].offsetTop; });
      observer.observe(scroller);
    });
  }
  scroller.addEventListener("scroll", () => {
    if (navigating || !body.classList.contains("company-phone-slides")) return;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(visibleSlide);
  }, { passive: true });
  phone.addEventListener("change", () => window.dispatchEvent(new Event("hashchange")));
  window.addEventListener("hashchange", sync);
  window.addEventListener("pageshow", sync);
  sync();
})();
