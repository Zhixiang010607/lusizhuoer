const ORIGINAL_MAX_BYTES = 3 * 1024 * 1024;
const THUMBNAIL_MAX_BYTES = 350 * 1024;

function fileInfo(path) {
  return new Promise((resolve, reject) => wx.getFileSystemManager().getFileInfo({ filePath: path, success: resolve, fail: reject }));
}
function imageInfo(path) {
  return new Promise((resolve, reject) => wx.getImageInfo({ src: path, success: resolve, fail: reject }));
}
function compress(path, quality) {
  return new Promise((resolve, reject) => wx.compressImage({ src: path, quality, success: (result) => resolve(result.tempFilePath), fail: reject }));
}
function base64(path, mimeType = "image/jpeg") {
  return new Promise((resolve, reject) => wx.getFileSystemManager().readFile({ filePath: path, encoding: "base64", success: (result) => resolve(`data:${mimeType};base64,${result.data}`), fail: reject }));
}

Component({
  properties: { title: { type: String, value: "现场拍照" } },
  data: { previewPath: "", captureReady: false, busy: false, message: "", error: false },
  lifetimes: { detached() { this.clearCapture(); } },
  methods: {
    async takePhoto() {
      if (this.data.busy) return;
      this.setData({ busy: true, message: "正在打开摄像头…", error: false });
      try {
        const chosen = await new Promise((resolve, reject) => wx.chooseMedia({
          count: 1, mediaType: ["image"], sourceType: ["camera"], sizeType: ["original"], camera: "front", success: resolve, fail: reject
        }));
        let originalPath = chosen.tempFiles && chosen.tempFiles[0] && chosen.tempFiles[0].tempFilePath;
        if (!originalPath) throw new Error("摄像头没有返回照片");
        let originalInfo = await fileInfo(originalPath);
        if (Number(originalInfo.size) > ORIGINAL_MAX_BYTES) {
          originalPath = await compress(originalPath, 88);
          originalInfo = await fileInfo(originalPath);
        }
        if (Number(originalInfo.size) > ORIGINAL_MAX_BYTES) throw new Error("照片超过 3MB，请改善光线后重新拍摄");
        const dimensions = await imageInfo(originalPath);
        let thumbnailPath = await compress(originalPath, 25);
        let thumbnailInfo = await fileInfo(thumbnailPath);
        if (Number(thumbnailInfo.size) > THUMBNAIL_MAX_BYTES) {
          thumbnailPath = await compress(originalPath, 10);
          thumbnailInfo = await fileInfo(thumbnailPath);
        }
        if (Number(thumbnailInfo.size) > THUMBNAIL_MAX_BYTES) throw new Error("缩略图仍然过大，请重新拍摄并减少复杂背景");
        const thumbnailDimensions = await imageInfo(thumbnailPath);
        const originalMime = String(dimensions.type || "jpeg").toLowerCase() === "png" ? "image/png" : "image/jpeg";
        const thumbnailMime = String(thumbnailDimensions.type || "jpeg").toLowerCase() === "png" ? "image/png" : "image/jpeg";
        this._capture = {
          originalPath,
          thumbnailPath,
          imageBase64: await base64(originalPath, originalMime),
          thumbnailBase64: await base64(thumbnailPath, thumbnailMime),
          imageWidth: Number(dimensions.width || 0),
          imageHeight: Number(dimensions.height || 0),
          originalBytes: Number(originalInfo.size || 0),
          thumbnailBytes: Number(thumbnailInfo.size || 0)
        };
        this.setData({ previewPath: originalPath, captureReady: true, message: "照片已拍摄；提交前仍需由服务端完成质量、活体与人脸检查", error: false });
        this.triggerEvent("change", { ready: true });
      } catch (error) {
        const cancelled = /cancel/i.test(String(error && (error.errMsg || error.message) || ""));
        this.clearCapture();
        this.setData({ message: cancelled ? "已取消拍照" : (error.message || error.errMsg || "拍照失败"), error: !cancelled });
        this.triggerEvent("change", { ready: false });
      } finally { this.setData({ busy: false }); }
    },
    clearCapture() { this._capture = null; },
    reset() {
      this.clearCapture();
      this.setData({ previewPath: "", captureReady: false, message: "", error: false });
      this.triggerEvent("change", { ready: false });
    },
    getCapture() { return this._capture ? { ...this._capture } : null; }
  }
});
