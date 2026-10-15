"use strict";

// Only attendance uses this derivative. Customer/verification evidence never
// enters this pipeline. Vector digit paths avoid deployment font dependencies.
const GLYPHS = require("./attendance-glyphs.json").glyphs;

function shanghaiStamp(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid server attendance timestamp");
  const d = new Date(date.getTime() + 8 * 3600000), pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function stampSvg(text, imageWidth, attendanceType) {
  if (!["CLOCK_IN", "CLOCK_OUT"].includes(attendanceType)) throw new Error("Invalid punch type");
  const size = Math.max(12, Math.round(imageWidth / 36)), labelSize = Math.round(size * .8);
  const label = `${attendanceType === "CLOCK_OUT" ? "下班打卡" : "上班打卡"} 北京时间`;
  const units = (line) => [...line].reduce((sum, c) => sum + GLYPHS[c].width, 0);
  const padding = Math.round(size * .5), width = Math.ceil(Math.max(units(text) * size, units(label) * labelSize) / 1000) + padding * 2;
  const height = Math.ceil(size * 2.5) + padding * 2;
  const line = (value, fontSize, baseline, color) => {
    let x = padding;
    return [...value].map((c) => {
      const glyph = GLYPHS[c], path = `<path d="${glyph.path}" fill="${color}" transform="translate(${x},${baseline}) scale(${fontSize / 1000},${-fontSize / 1000})"/>`;
      x += glyph.width * fontSize / 1000; return path;
    }).join("");
  };
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" rx="${padding / 2}" fill="#000" fill-opacity=".6"/>${line(label, labelSize, padding + labelSize, "#f8ddb0")}${line(text, size, padding + size * 2.1, "#fff")}</svg>`);
}

async function prepareAttendancePhoto(buffer, timestamp, attendanceType) {
  const sharp = require("sharp"); // Lazy: not loaded by the verification-photo-only service.
  for (const edge of [1280, 1024, 768]) {
    const image = await sharp(buffer, { limitInputPixels: 24 * 1024 * 1024, failOn: "error" })
      .rotate().resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .raw().toBuffer({ resolveWithObject: true });
    if (image.info.width < 160 || image.info.height < 160) throw new Error("Attendance image too small");
    const overlay = stampSvg(shanghaiStamp(timestamp), image.info.width, attendanceType);
    for (const quality of [78, 68]) {
      const result = await sharp(image.data, { raw: { width: image.info.width, height: image.info.height, channels: image.info.channels } })
        .composite([{ input: overlay, gravity: "southeast" }])
        .jpeg({ quality, chromaSubsampling: "4:2:0" }).toBuffer({ resolveWithObject: true });
      if (result.data.length <= 512 * 1024) return { buffer: result.data, width: result.info.width, height: result.info.height };
    }
  }
  throw new Error("Attendance image exceeds compressed size limit");
}

module.exports = { prepareAttendancePhoto, shanghaiStamp, stampSvg };
