"use strict";

function photoWorkerError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function jpegBlob(canvas, quality) {
  return canvas.convertToBlob({ type: "image/jpeg", quality });
}

async function decodePhoto(file) {
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch (_) {
    try { return await createImageBitmap(file); }
    catch (_) { throw photoWorkerError("不支持该照片格式，请使用相机、JPEG 或 PNG", "PHOTO_DECODE_FAILED"); }
  }
}

async function processPhoto(message) {
  const file = message.file;
  const maxInputBytes = Number(message.maxInputBytes || 20 * 1024 * 1024);
  const maxOutputBytes = Number(message.maxOutputBytes || 3 * 1024 * 1024);
  if (!file || Number(file.size || 0) <= 0) throw photoWorkerError("请选择一张有效照片", "PHOTO_FILE_INVALID");
  if (file.size > maxInputBytes) throw photoWorkerError("原始文件不能超过 20 MB", "PHOTO_FILE_TOO_LARGE");

  let bitmap = await decodePhoto(file);
  let originalCanvas = null;
  let reducedCanvas = null;
  let thumbnailCanvas = null;
  try {
    const sourceWidth = Number(bitmap.width || 0);
    const sourceHeight = Number(bitmap.height || 0);
    if (!sourceWidth || !sourceHeight) throw photoWorkerError("无法读取照片尺寸", "PHOTO_DIMENSIONS_INVALID");
    const originalScale = Math.min(1, 2400 / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * originalScale));
    const height = Math.max(1, Math.round(sourceHeight * originalScale));

    if (width !== sourceWidth || height !== sourceHeight) {
      const resized = await createImageBitmap(bitmap, 0, 0, sourceWidth, sourceHeight, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: "high"
      });
      bitmap.close();
      bitmap = resized;
    }

    originalCanvas = new OffscreenCanvas(width, height);
    originalCanvas.getContext("2d", { alpha: false, desynchronized: true }).drawImage(bitmap, 0, 0, width, height);
    let originalBlob = await jpegBlob(originalCanvas, 0.92);
    if (originalBlob.size > maxOutputBytes) originalBlob = await jpegBlob(originalCanvas, 0.86);

    let finalCanvas = originalCanvas;
    let finalWidth = width;
    let finalHeight = height;
    if (originalBlob.size > maxOutputBytes) {
      const scale = Math.min(1, 1800 / Math.max(width, height));
      finalWidth = Math.max(1, Math.round(width * scale));
      finalHeight = Math.max(1, Math.round(height * scale));
      reducedCanvas = new OffscreenCanvas(finalWidth, finalHeight);
      reducedCanvas.getContext("2d", { alpha: false, desynchronized: true }).drawImage(originalCanvas, 0, 0, finalWidth, finalHeight);
      finalCanvas = reducedCanvas;
      originalBlob = await jpegBlob(finalCanvas, 0.88);
    }
    if (originalBlob.size > maxOutputBytes) throw photoWorkerError("照片处理后仍超过 3 MB，请换一张照片", "PHOTO_OUTPUT_TOO_LARGE");

    const thumbScale = Math.min(1, 480 / Math.max(finalWidth, finalHeight));
    const thumbWidth = Math.max(1, Math.round(finalWidth * thumbScale));
    const thumbHeight = Math.max(1, Math.round(finalHeight * thumbScale));
    thumbnailCanvas = new OffscreenCanvas(thumbWidth, thumbHeight);
    thumbnailCanvas.getContext("2d", { alpha: false, desynchronized: true }).drawImage(finalCanvas, 0, 0, thumbWidth, thumbHeight);
    const thumbnailBlob = await jpegBlob(thumbnailCanvas, 0.82);
    return { originalBlob, thumbnailBlob, imageWidth: finalWidth, imageHeight: finalHeight };
  } finally {
    bitmap?.close?.();
    if (originalCanvas) { originalCanvas.width = 1; originalCanvas.height = 1; }
    if (reducedCanvas) { reducedCanvas.width = 1; reducedCanvas.height = 1; }
    if (thumbnailCanvas) { thumbnailCanvas.width = 1; thumbnailCanvas.height = 1; }
  }
}

self.addEventListener("message", async (event) => {
  const message = event.data || {};
  try {
    const result = await processPhoto(message);
    self.postMessage({ id: message.id, ok: true, ...result });
  } catch (error) {
    self.postMessage({
      id: message.id,
      ok: false,
      code: error?.code || "PHOTO_PREPARE_FAILED",
      message: error?.message || "浏览器无法处理照片"
    });
  }
});
