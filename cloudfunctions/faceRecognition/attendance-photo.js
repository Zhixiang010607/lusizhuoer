"use strict";

// Attendance adds its authoritative timestamp to the same verified capture.
// Keep native pixels and work-order HD JPEG quality; never use a low-res loop.
// Customer/verification evidence never enters this watermark-only pipeline.
const GLYPHS = require("./attendance-glyphs.json").glyphs;

function shanghaiStamp(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid server attendance timestamp");
  const d = new Date(date.getTime() + 8 * 3600000), pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function stampSvg(text, imageWidth, attendanceType, imageHeight = Infinity) {
  if (!["CLOCK_IN", "CLOCK_OUT"].includes(attendanceType)) throw new Error("Invalid punch type");
  const originalSize = Math.max(12, Math.round(imageWidth / 36)), labelSize = Math.round(originalSize * .8);
  const label = `${attendanceType === "CLOCK_OUT" ? "下班打卡" : "上班打卡"} 北京时间`;
  const units = (line) => [...line].reduce((sum, c) => sum + GLYPHS[c].width, 0);
  const padding = Math.round(originalSize * .5);
  // Enlarge only the timestamp, not the punch label. Clamp small captures so
  // the complete authoritative date/time stays inside the original image.
  const size = Math.min(Math.max(16, Math.round(imageWidth / 18)), Math.floor((imageWidth - padding * 2) * 1000 / units(text)));
  const gap = Math.max(4, Math.round(originalSize * .3));
  const width = Math.ceil(Math.max(units(text) * size, units(label) * labelSize) / 1000) + padding * 2;
  const height = Math.ceil(labelSize + gap + size * 1.2) + padding * 2;
  const scale = Math.min(1, imageHeight / height);
  const line = (value, fontSize, baseline, color, weight = 0) => {
    let x = padding;
    return [...value].map((c) => {
      const glyph = GLYPHS[c], path = `<path d="${glyph.path}" fill="${color}" stroke="${color}" stroke-width="${weight}" stroke-linejoin="round" transform="translate(${x},${baseline}) scale(${fontSize / 1000},${-fontSize / 1000})"/>`;
      x += glyph.width * fontSize / 1000; return path;
    }).join("");
  };
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width * scale)}" height="${Math.ceil(height * scale)}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" rx="${padding / 2}" fill="#000" fill-opacity=".6"/>${line(label, labelSize, padding + labelSize, "#f8ddb0")}${line(text, size, padding + labelSize + gap + size, "#fff", 18)}</svg>`);
}

async function prepareAttendancePhoto(buffer, timestamp, attendanceType) {
  const sharp = require("sharp"); // Lazy: not loaded by the verification-photo-only service.
  const image = await sharp(buffer, { limitInputPixels: 24 * 1024 * 1024, failOn: "error" })
    .rotate().raw().toBuffer({ resolveWithObject: true });
  if (image.info.width < 160 || image.info.height < 160 || image.info.width > 10000 || image.info.height > 10000) {
    throw new Error("Attendance image dimensions invalid");
  }
  const overlay = stampSvg(shanghaiStamp(timestamp), image.info.width, attendanceType, image.info.height);
  const result = await sharp(image.data, { raw: { width: image.info.width, height: image.info.height, channels: image.info.channels } })
    .composite([{ input: overlay, gravity: "southeast" }])
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer({ resolveWithObject: true });
  if (result.data.length > 3 * 1024 * 1024) {
    const error = new Error("Attendance HD photo exceeds 3 MiB; do not silently downscale");
    error.code = "ATTENDANCE_HD_PHOTO_TOO_LARGE";
    throw error;
  }
  return { buffer: result.data, width: result.info.width, height: result.info.height };
}

// Explicit release probe: synthetic pixels only, no identity, storage or SQL.
// Cache per warm instance so repeated health requests do not repeat image work.
let runtimeProbe;
function probeAttendancePhotoRuntime() {
  if (!runtimeProbe) runtimeProbe = (async () => {
    const runtime = { node: process.versions.node, platform: process.platform, arch: process.arch };
    try {
      const sharp = require("sharp");
      const input = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#cdbb9c" } }).jpeg().toBuffer();
      const bytes = [];
      for (const type of ["CLOCK_IN", "CLOCK_OUT"]) {
        const result = await prepareAttendancePhoto(input, "2026-10-15T01:02:03Z", type);
        const metadata = await sharp(result.buffer).metadata();
        if (metadata.format !== "jpeg" || metadata.width !== 320 || metadata.height !== 240 || result.buffer.length > 3 * 1024 * 1024) throw new Error("probe failed");
        bytes.push(result.buffer.length);
      }
      return { ready: true, ...runtime, sharp: sharp.versions.sharp, jpegBytes: bytes };
    } catch (_) {
      return { ready: false, ...runtime, errorCode: "ATTENDANCE_PHOTO_RUNTIME_UNAVAILABLE" };
    }
  })();
  return runtimeProbe;
}

module.exports = { prepareAttendancePhoto, shanghaiStamp, stampSvg, probeAttendancePhotoRuntime };
