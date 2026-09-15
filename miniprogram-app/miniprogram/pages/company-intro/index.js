const PROJECT_KEYS = Object.freeze(["ocean", "skin", "warmth"]);
const CONTACT_PHONES = Object.freeze(["18179422788", "18160789986"]);
const SLIDE_NUMBERS = Object.freeze(["01", "02", "03", "04", "05", "06"]);

function dialContact(page, phoneNumber) {
  if (!page || page._calling || !CONTACT_PHONES.includes(phoneNumber)) return;
  page._calling = true;
  wx.makePhoneCall({
    phoneNumber,
    fail: error => {
      if (!String(error && error.errMsg || "").includes("cancel")) {
        wx.showToast({ title: "暂时无法拨打，请稍后重试", icon: "none" });
      }
    },
    complete: () => { page._calling = false; }
  });
}

Page({
  data: {
    currentSlide: 0,
    reading: 0,
    scrolled: false,
    slideNumbers: SLIDE_NUMBERS,
    topbarStyle: "",
    loginStyle: ""
  },
  onLoad() { this.configureTopbar(); },
  configureTopbar() {
    if (typeof wx.getWindowInfo !== "function") return;
    const windowInfo = wx.getWindowInfo();
    const statusBarHeight = Math.max(20, Number(windowInfo.statusBarHeight) || 24);
    let topbarHeight = statusBarHeight + 44;
    let loginRight = 104;
    if (typeof wx.getMenuButtonBoundingClientRect === "function") {
      const menu = wx.getMenuButtonBoundingClientRect();
      const menuTop = Number(menu && menu.top);
      const menuBottom = Number(menu && menu.bottom);
      const menuLeft = Number(menu && menu.left);
      if (menuTop > 0 && menuBottom > menuTop) {
        topbarHeight = menuBottom + Math.max(4, menuTop - statusBarHeight);
      }
      if (menuLeft > 0 && Number(windowInfo.windowWidth) > menuLeft) {
        loginRight = Number(windowInfo.windowWidth) - menuLeft + 10;
      }
    }
    this.setData({
      topbarStyle: `height:${Math.ceil(topbarHeight)}px;`,
      loginStyle: `right:${Math.ceil(loginRight)}px;`
    });
  },
  onSlideChange(event) {
    const requested = Number(event && event.detail && event.detail.current);
    const currentSlide = Number.isInteger(requested)
      ? Math.max(0, Math.min(SLIDE_NUMBERS.length - 1, requested))
      : 0;
    this.setData({
      currentSlide,
      reading: Math.round(currentSlide / (SLIDE_NUMBERS.length - 1) * 100),
      scrolled: currentSlide > 0
    });
  },
  openLogin() {
    if (this._navigating) return;
    this._navigating = true;
    wx.navigateTo({
      url: "/pages/login/index",
      fail: () => wx.showToast({ title: "暂时无法打开，请重试", icon: "none" }),
      complete: () => { this._navigating = false; }
    });
  },
  callPhone(event) {
    const phoneNumber = event && event.currentTarget && event.currentTarget.dataset.phone;
    dialContact(this, phoneNumber);
  },
  openProjectIntro(event) {
    if (this._navigating) return;
    const project = event && event.currentTarget && event.currentTarget.dataset.project;
    if (!PROJECT_KEYS.includes(project)) return;
    this._navigating = true;
    wx.navigateTo({
      url: `/pages/project-intro/index?project=${project}`,
      fail: () => wx.showToast({ title: "暂时无法打开，请重试", icon: "none" }),
      complete: () => { this._navigating = false; }
    });
  }
});
