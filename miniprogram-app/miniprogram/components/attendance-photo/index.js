const { callFace } = require("../../services/api");
const localFiles = new Map();
function identity() { return String(getApp().globalData?.session?.profile?.staffId || getApp().globalData?.session?.staffId || ""); }
function privateFile(id, base64, expectedBytes) {
  const path = `${wx.env.USER_DATA_PATH}/attendance_${id}_${Date.now()}.jpg`;
  const text = String(base64 || ""), bytes = text.length * 3 / 4 - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || bytes !== expectedBytes || bytes > 3 * 1024 * 1024) return Promise.reject(new Error("照片读取不完整"));
  const fs = wx.getFileSystemManager();
  return new Promise((resolve, reject) => fs.writeFile({ filePath: path, data: text, encoding: "base64", success: () => {
    fs.getFileInfo({ filePath: path, success: (info) => {
      if (info.size === expectedBytes) resolve(path);
      else { fs.unlink({ filePath: path, fail() {} }); reject(new Error("照片读取不完整")); }
    }, fail: (error) => { fs.unlink({ filePath: path, fail() {} }); reject(error); } });
  }, fail: reject }));
}
function usable(entry, expectedBytes) {
  if (!entry || entry.expires <= Date.now()) return false;
  try { return wx.getFileSystemManager().statSync(entry.path).size === expectedBytes; } catch (_) { return false; }
}
function aspectPercent(photo) {
  const width = Number(photo?.width), height = Number(photo?.height);
  return Number.isFinite(width) && Number.isFinite(height) && width >= 160 && width <= 10000 && height >= 160 && height <= 10000
    ? Number((height / width * 100).toFixed(4)) : 133.3333;
}
Component({
  properties: { fill: { type: Boolean, value: false }, attendanceId: { type: String, value: "", observer() { if (this._alive) this.load(); } } },
  data: { url: "", aspectPercent: 133.3333, loading: false, missing: false, error: "", reading: false },
  lifetimes: {
    attached() { this._alive = true; this.load(); },
    detached() { this._alive = false; this._epoch = (this._epoch || 0) + 1; }
  },
  methods: {
    current(epoch, account) { return this._alive && this._epoch === epoch && identity() === account; },
    async load() {
      const id = this.properties.attendanceId, epoch = this._epoch = (this._epoch || 0) + 1, account = identity();
      this.setData({ url: "", aspectPercent: 133.3333, missing: false, error: "", reading: false, loading: Boolean(id) });
      if (!id) return;
      try {
        // Request the stored original even against the older compatible server.
        const result = await callFace("getAttendancePhoto", { attendanceId: id, original: true });
        if (!this.current(epoch, account)) return;
        if (result.attendanceId !== id) throw new Error("打卡照片不匹配");
        const cached = localFiles.get(`${account}:${id}`);
        this.setData({ url: result.photo && usable(cached, Number(result.photo.bytes)) ? cached.path : result.photo?.url || "",
          aspectPercent: aspectPercent(result.photo), missing: !result.photo });
      } catch (_) { if (this.current(epoch, account)) this.setData({ error: "照片读取失败，点击重读" }); }
      finally { if (this.current(epoch, account)) this.setData({ loading: false }); }
    },
    imageError() { this.setData({ url: "", error: "照片读取失败，点击重读" }); },
    async read() {
      if (this.data.reading || this.data.loading || this.data.missing) return;
      const epoch = this._epoch, account = identity(), id = this.properties.attendanceId, key = `${account}:${id}`;
      this.setData({ reading: true, error: "" });
      try {
        // Reauthorize even on a local cache hit. Never persist signed URLs or Base64.
        const access = await callFace("getAttendancePhoto", { attendanceId: id, authorizeOnly: true });
        if (!this.current(epoch, account)) return;
        if (access.attendanceId !== id || !access.photo) throw new Error("照片不存在");
        let cached = localFiles.get(key);
        if (!usable(cached, Number(access.photo.bytes))) {
          if (cached?.path) wx.getFileSystemManager().unlink({ filePath: cached.path, fail() {} });
          const result = await callFace("getAttendancePhoto", { attendanceId: id, readBytes: true });
          if (!this.current(epoch, account)) return;
          if (result.attendanceId !== id || !result.photo?.imageBase64) throw new Error("照片读取失败");
          const path = await privateFile(id, result.photo.imageBase64, Number(result.photo.bytes));
          if (!this.current(epoch, account)) { wx.getFileSystemManager().unlink({ filePath: path, fail() {} }); return; }
          cached = { path, expires: Date.now() + 24 * 3600000 };
          localFiles.set(key, cached);
          for (const [oldKey, entry] of localFiles) {
            if (entry.expires <= Date.now() || localFiles.size > 30) {
              localFiles.delete(oldKey); wx.getFileSystemManager().unlink({ filePath: entry.path, fail() {} });
            }
          }
        }
        if (this.current(epoch, account)) {
          this.setData({ url: cached.path });
          wx.previewImage({ current: cached.path, urls: [cached.path] });
        }
      } catch (_) { if (this.current(epoch, account)) this.setData({ error: "照片读取失败，点击重读" }); }
      finally { if (this.current(epoch, account)) this.setData({ reading: false }); }
    }
  }
});
