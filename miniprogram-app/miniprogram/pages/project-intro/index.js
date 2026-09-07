const { getProject } = require("./content");

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

Page({
  data: {
    project: null, unavailable: false, motion: true, compact: false,
    stageHeight: 620, storyHeight: 1900, chapter: 0, reading: 0,
    heroStyle: "", layerOne: "", layerTwo: "", layerThree: "",
    ringStyle: "", glowStyle: "", pulseStyle: "", heroFailed: false, noticeOpen: false
  },
  onLoad(options) {
    this._alive = true;
    this._measureEpoch = 0;
    this._scrollTop = 0;
    const project = getProject(options && options.project);
    if (!project) { this.setData({ unavailable: true }); return; }
    this.setData({ project });
    this.sizeStage();
  },
  onReady() { this.measure(); },
  onShow() { if (this._ready) this.measure(); },
  onResize() { this.sizeStage(() => this.measure()); },
  onUnload() { this._alive = false; this._measureEpoch += 1; },
  sizeStage(complete) {
    const info = wx.getWindowInfo();
    // Short phones and landscape need normal document flow so copy and tabs stay visible.
    const compact = info.windowHeight < 670;
    const stageHeight = clamp(info.windowHeight - 52, 420, 700);
    this.setData({ compact, stageHeight, storyHeight: Math.round(stageHeight * 3.4) }, complete);
  },
  measure() {
    if (!this._alive || !this.data.project) return;
    this._ready = true;
    const epoch = ++this._measureEpoch;
    const query = wx.createSelectorQuery().in(this);
    query.select("#intro-story").boundingClientRect();
    query.select("#intro-content").boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec((result) => {
      if (!this._alive || epoch !== this._measureEpoch || !result || !result[0] || !result[1]) return;
      const scrollTop = Number(result[2] && result[2].scrollTop || 0);
      this._storyTop = result[0].top + scrollTop - 52;
      this._storyTravel = Math.max(1, result[0].height - this.data.stageHeight);
      this._pageTravel = Math.max(1, result[1].height - wx.getWindowInfo().windowHeight);
      this._scrollTop = scrollTop;
      this.renderScroll(true);
    });
  },
  onPageScroll(event) {
    this._scrollTop = Math.max(0, Number(event.scrollTop) || 0);
    this.renderScroll(false);
  },
  renderScroll(force) {
    if (!this._alive || !this.data.project || this._storyTop === undefined) return;
    const progress = clamp((this._scrollTop - this._storyTop) / this._storyTravel, 0, 1);
    const chapter = this.data.compact ? this.data.chapter : Math.min(2, Math.floor(progress * 3));
    const reading = Math.round(clamp(this._scrollTop / this._pageTravel, 0, 1) * 100);
    const now = Date.now();
    // Never drop a chapter boundary or the reading position when motion is off.
    if (!force && chapter === this.data.chapter && reading === this.data.reading && now - (this._lastPaint || 0) < 48) return;
    this._lastPaint = now;
    const move = this.data.motion && !this.data.compact;
    const spread = move ? 18 + 42 * progress : 42;
    const patch = {
      chapter, reading,
      heroStyle: move ? `transform:translateY(${Math.min(this._scrollTop * 0.1, 55).toFixed(1)}px) scale(${(1 + Math.min(this._scrollTop / 14000, 0.045)).toFixed(3)});` : "",
      layerOne: `transform:translateY(${-spread.toFixed(1)}px);`,
      layerTwo: "transform:translateY(0px);",
      layerThree: `transform:translateY(${spread.toFixed(1)}px);`,
      ringStyle: move ? `transform:rotate(${(progress * 42 - 12).toFixed(1)}deg);` : "",
      glowStyle: move ? `opacity:${(0.3 + progress * 0.6).toFixed(2)};transform:scale(${(0.8 + progress * 0.3).toFixed(2)});` : "",
      pulseStyle: move ? `transform:scaleX(${(0.7 + progress * 0.3).toFixed(2)});` : ""
    };
    const changed = {};
    Object.keys(patch).forEach(key => { if (patch[key] !== this.data[key]) changed[key] = patch[key]; });
    if (Object.keys(changed).length) this.setData(changed);
  },
  toggleMotion() {
    this.setData({ motion: !this.data.motion });
    this.renderScroll(true);
  },
  explore() {
    wx.pageScrollTo({ selector: "#intro-concept", offsetTop: -52, duration: this.data.motion ? 400 : 0 });
  },
  selectChapter(event) {
    const chapter = Number(event.currentTarget.dataset.chapter);
    if (!Number.isInteger(chapter) || chapter < 0 || chapter > 2 || this._storyTop === undefined) return;
    this.setData({ chapter });
    if (this.data.compact) return;
    wx.pageScrollTo({ scrollTop: Math.round(this._storyTop + this._storyTravel * (chapter + 0.12) / 3), duration: this.data.motion ? 320 : 0 });
  },
  heroError() { this.setData({ heroFailed: true }); },
  toggleNotice() {
    this.setData({ noticeOpen: !this.data.noticeOpen }, () => {
      if (!this._alive) return;
      this.measure();
      if (this.data.noticeOpen) wx.pageScrollTo({ selector: "#intro-notice", offsetTop: -68, duration: this.data.motion ? 240 : 0 });
    });
  },
  openNext() {
    if (this._navigating || !this.data.project) return;
    const project = getProject(this.data.project.nextKey);
    if (!project) return;
    this._navigating = true;
    wx.redirectTo({
      url: `/pages/project-intro/index?project=${project.key}`,
      fail: () => wx.showToast({ title: "暂时无法打开，请重试", icon: "none" }),
      complete: () => { this._navigating = false; }
    });
  },
  returnToLogin() {
    if (this._navigating) return;
    this._navigating = true;
    const pages = getCurrentPages();
    const loginIndex = pages.findIndex(page => page.route === "pages/login/index");
    const options = {
      fail: () => wx.showToast({ title: "暂时无法返回，请重试", icon: "none" }),
      complete: () => { this._navigating = false; }
    };
    if (loginIndex >= 0 && loginIndex < pages.length - 1) wx.navigateBack({ ...options, delta: pages.length - 1 - loginIndex });
    else wx.reLaunch({ ...options, url: "/pages/login/index" });
  }
});
