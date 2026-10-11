"use strict";

const STORAGE_KEY = "training-material-private-cache-v1";
const MAX_CACHE_BYTES = 120 * 1024 * 1024;

function clean(value) { return String(value ?? "").trim(); }
function fileSystem() { return wx.getFileSystemManager(); }
function fileInfo(filePath) { return new Promise((resolve, reject) => fileSystem().getFileInfo({ filePath, success: resolve, fail: reject })); }
function copyFile(sourcePath, destinationPath) {
  return new Promise((resolve, reject) => fileSystem().copyFile({ srcPath: sourcePath, destPath: destinationPath, success: resolve, fail: reject }));
}
function unlinkFile(filePath) { return new Promise((resolve, reject) => fileSystem().unlink({ filePath, success: resolve, fail: reject })); }

function fingerprint(material = {}) {
  return [clean(material.id), Number(material.bytes || 0), clean(material.publishedAt || material.createdAt)].join(":");
}

function pathToken(value) {
  let hash = 2166136261;
  for (const char of clean(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

function cachePath(material) {
  const id = clean(material?.id).replace(/[^A-Za-z0-9_-]/g, "_");
  return `${wx.env.USER_DATA_PATH}/training-material-cache-${id}-${pathToken(fingerprint(material))}.pdf`;
}

function normalize(entry = {}) {
  return {
    id: clean(entry.id), fingerprint: clean(entry.fingerprint), filePath: clean(entry.filePath),
    bytes: Math.max(0, Number(entry.bytes || 0)), lastOpenedAt: Math.max(0, Number(entry.lastOpenedAt || 0))
  };
}

function readEntries() {
  try {
    const stored = wx.getStorageSync(STORAGE_KEY);
    return (Array.isArray(stored) ? stored : []).map(normalize).filter((entry) => entry.id && entry.fingerprint && entry.filePath);
  } catch (_) { return []; }
}

function writeEntries(entries) {
  try { wx.setStorageSync(STORAGE_KEY, entries.map(normalize).filter((entry) => entry.id && entry.fingerprint && entry.filePath)); }
  catch (_) {}
}

async function removeEntry(entry) {
  if (entry?.filePath) await unlinkFile(entry.filePath).catch(() => {});
}

async function find(material) {
  const wanted = fingerprint(material);
  const entries = readEntries();
  const matching = entries.find((entry) => entry.id === clean(material?.id) && entry.fingerprint === wanted);
  if (!matching) return "";
  try {
    const info = await fileInfo(matching.filePath);
    const expectedBytes = Number(material?.bytes || matching.bytes || 0);
    if (!Number(info?.size || 0) || (expectedBytes && Number(info.size) !== expectedBytes)) throw new Error("cache size mismatch");
    matching.lastOpenedAt = Date.now();
    writeEntries(entries);
    return matching.filePath;
  } catch (_) {
    await removeEntry(matching);
    writeEntries(entries.filter((entry) => entry !== matching));
    return "";
  }
}

async function store(tempFilePath, material) {
  const bytes = Number(material?.bytes || 0);
  if (!tempFilePath || !Number.isSafeInteger(bytes) || bytes < 8 || bytes > 100 * 1024 * 1024) return "";
  const wanted = fingerprint(material);
  let entries = readEntries();
  const obsolete = entries.filter((entry) => entry.id === clean(material.id) && entry.fingerprint !== wanted);
  for (const entry of obsolete) await removeEntry(entry);
  entries = entries.filter((entry) => !obsolete.includes(entry));

  const current = entries.find((entry) => entry.fingerprint === wanted);
  if (current) {
    const existing = await find(material);
    if (existing) return existing;
    entries = readEntries();
  }

  let used = entries.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0);
  for (const entry of [...entries].sort((a, b) => a.lastOpenedAt - b.lastOpenedAt)) {
    if (used + bytes <= MAX_CACHE_BYTES) break;
    await removeEntry(entry);
    used -= Number(entry.bytes || 0);
    entries = entries.filter((item) => item !== entry);
  }

  const filePath = cachePath(material);
  await unlinkFile(filePath).catch(() => {});
  await copyFile(tempFilePath, filePath);
  const info = await fileInfo(filePath);
  if (Number(info?.size || 0) !== bytes) {
    await unlinkFile(filePath).catch(() => {});
    throw new Error("培训 PDF 本地缓存不完整");
  }
  entries.push(normalize({ id: material.id, fingerprint: wanted, filePath, bytes, lastOpenedAt: Date.now() }));
  writeEntries(entries);
  return filePath;
}

async function invalidate(materialId) {
  const id = clean(materialId);
  const entries = readEntries();
  const targets = entries.filter((entry) => entry.id === id);
  for (const entry of targets) await removeEntry(entry);
  writeEntries(entries.filter((entry) => entry.id !== id));
}

module.exports = { STORAGE_KEY, MAX_CACHE_BYTES, find, store, invalidate };
