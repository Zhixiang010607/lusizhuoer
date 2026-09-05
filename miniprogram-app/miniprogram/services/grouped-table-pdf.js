"use strict";

const PDF_EXPORT_MAX_ROWS = 1000;
const CJK_FONT_FILENAME = "NotoSansCJKsc-Common-Identity.br";
const PAGE_WIDTH = 841.89;
const PAGE_HEIGHT = 595.28;
const MARGIN = 30;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 24;
const GROUP_HEIGHT = 24;
const BOTTOM = 34;
const COLORS = Object.freeze({
  background: [1, 0.984, 0.953], band: [0.475, 0.349, 0.184], dark: [0.188, 0.165, 0.133],
  muted: [0.42, 0.373, 0.31], pale: [0.957, 0.91, 0.835], paleAlt: [0.99, 0.969, 0.929],
  line: [0.86, 0.79, 0.68], white: [1, 1, 1]
});

function clean(value, fallback = "—") {
  const output = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return output || fallback;
}
function decimal(value) { return Number(Number(value).toFixed(3)).toString(); }
function color(value) { return value.map(decimal).join(" "); }
function safeFilename(value) {
  return clean(value, "运营指标查询结果").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").slice(0, 100);
}
function pdfText(value, mappings) {
  let output = "";
  for (const character of Array.from(clean(value, ""))) {
    const point = character.codePointAt(0);
    const cid = point <= 0xffff ? point : 0x25a1;
    mappings.set(cid, cid);
    output += cid.toString(16).padStart(4, "0").toUpperCase();
  }
  return `<${output || "0020"}>`;
}
function pdfAsciiText(value) {
  let output = "";
  for (const character of Array.from(clean(value, ""))) {
    const point = character.codePointAt(0);
    output += (point >= 0x20 && point <= 0xff ? point : 0x3f).toString(16).padStart(2, "0").toUpperCase();
  }
  return `<${output || "20"}>`;
}
function textRuns(value) {
  const runs = [];
  for (const character of Array.from(String(value || ""))) {
    const ascii = character.codePointAt(0) <= 0xff;
    const previous = runs[runs.length - 1];
    if (previous && previous.ascii === ascii) previous.value += character;
    else runs.push({ ascii, value: character });
  }
  return runs;
}
function visualUnits(value) {
  return Array.from(String(value || "")).reduce((sum, character) => sum + (character.codePointAt(0) <= 0x7f ? 0.56 : 1), 0);
}
function fitted(value, width, size) {
  const source = clean(value);
  const maximum = Math.max(1, width / Math.max(1, size));
  if (visualUnits(source) <= maximum) return source;
  let output = "";
  for (const character of Array.from(source)) {
    if (visualUnits(`${output}${character}…`) > maximum) break;
    output += character;
  }
  return `${output}…`;
}
function wrapped(value, width, size) {
  const source = clean(value);
  const maximum = Math.max(1, width / Math.max(1, size));
  const lines = [];
  let line = "";
  for (const character of Array.from(source)) {
    if (line && visualUnits(`${line}${character}`) > maximum) {
      lines.push(line);
      line = character;
    } else {
      line += character;
    }
  }
  if (line || !lines.length) lines.push(line || " ");
  return lines;
}
function addFillRect(commands, x, top, width, height, fill) {
  commands.push(`${color(fill)} rg ${decimal(x)} ${decimal(PAGE_HEIGHT - top - height)} ${decimal(width)} ${decimal(height)} re f`);
}
function addStrokeRect(commands, x, top, width, height) {
  commands.push(`${color(COLORS.line)} RG 0.6 w ${decimal(x)} ${decimal(PAGE_HEIGHT - top - height)} ${decimal(width)} ${decimal(height)} re S`);
}
function addText(commands, value, x, top, size = 9, options = {}) {
  const width = Number(options.width || 0);
  const output = width ? fitted(value, Math.max(1, width - 8), size) : clean(value);
  let offset = 0;
  if (width && options.align === "center") offset = Math.max(0, (width - visualUnits(output) * size) / 2);
  if (width && options.align === "right") offset = Math.max(0, width - visualUnits(output) * size - 5);
  let cursor = x + offset;
  if (!commands.cjkMappings) commands.cjkMappings = new Map();
  textRuns(output).forEach((run) => {
    commands.push(`BT /${run.ascii ? "F2" : "F1"} ${decimal(size)} Tf ${color(options.color || COLORS.dark)} rg ${decimal(cursor)} ${decimal(PAGE_HEIGHT - top - size)} Td ${run.ascii ? pdfAsciiText(run.value) : pdfText(run.value, commands.cjkMappings)} Tj ET`);
    cursor += visualUnits(run.value) * size;
  });
}
function compareText(left, right) {
  try { return clean(left).localeCompare(clean(right), "zh-CN"); } catch (_) { return clean(left).localeCompare(clean(right)); }
}
function groupedRows(rows, groupKey, groupLabel) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = clean(groupKey(row), "未命名门店");
    const label = clean(groupLabel(row), "未命名门店");
    if (!groups.has(key)) groups.set(key, { key, label, rows: [] });
    groups.get(key).rows.push(row);
  });
  return [...groups.values()].sort((left, right) => compareText(left.label, right.label) || compareText(left.key, right.key));
}
function scaledColumns(columns) {
  const source = columns.map((column) => ({ ...column, weight: Math.max(1, Number(column.width || 16)) }));
  const total = source.reduce((sum, column) => sum + column.weight, 0);
  return source.map((column) => ({ ...column, pdfWidth: CONTENT_WIDTH * column.weight / total }));
}
function startPage(title, subtitle, continuation) {
  const commands = [];
  addFillRect(commands, 0, 0, PAGE_WIDTH, PAGE_HEIGHT, COLORS.background);
  addFillRect(commands, 0, 0, PAGE_WIDTH, 10, COLORS.band);
  addText(commands, title, MARGIN, 23, 17, { width: CONTENT_WIDTH * 0.7 });
  addText(commands, continuation ? "查询结果（续）" : subtitle, MARGIN + CONTENT_WIDTH * 0.7, 27, 9, {
    width: CONTENT_WIDTH * 0.3, align: "right", color: COLORS.muted
  });
  return { commands, top: 58 };
}
function drawGroupTitle(commands, label, count, top, continuation) {
  addFillRect(commands, MARGIN, top, CONTENT_WIDTH, GROUP_HEIGHT, COLORS.paleAlt);
  addStrokeRect(commands, MARGIN, top, CONTENT_WIDTH, GROUP_HEIGHT);
  addText(commands, `门店：${label}${continuation ? "（续）" : ""}（${count} 条）`, MARGIN + 8, top + 7, 9.5, { width: CONTENT_WIDTH - 16, color: COLORS.band });
}
function drawHeader(commands, columns, top) {
  let x = MARGIN;
  columns.forEach((column) => {
    addFillRect(commands, x, top, column.pdfWidth, HEADER_HEIGHT, COLORS.pale);
    addStrokeRect(commands, x, top, column.pdfWidth, HEADER_HEIGHT);
    addText(commands, column.header, x + 4, top + 7, 8.5, { width: column.pdfWidth - 8, align: "center" });
    x += column.pdfWidth;
  });
}
function drawRow(commands, columns, row, top, alternate) {
  let x = MARGIN;
  columns.forEach((column) => {
    addFillRect(commands, x, top, column.pdfWidth, ROW_HEIGHT, alternate ? COLORS.paleAlt : COLORS.white);
    addStrokeRect(commands, x, top, column.pdfWidth, ROW_HEIGHT);
    const value = typeof column.value === "function" ? column.value(row) : row[column.key];
    addText(commands, value, x + 4, top + 6, 8, {
      width: column.pdfWidth - 8,
      align: column.type === "number" ? "right" : (column.align || "left"),
      color: COLORS.muted
    });
    x += column.pdfWidth;
  });
}
function ascii(value) {
  const text = String(value);
  const output = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) output[index] = text.charCodeAt(index) & 0xff;
  return output;
}
function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part) => { output.set(part, offset); offset += part.byteLength; });
  return output;
}
function streamObject(value) {
  const bytes = ascii(value);
  return concatBytes([ascii(`<< /Length ${bytes.byteLength} >>\nstream\n`), bytes, ascii("\nendstream")]);
}
function byteView(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("PDF 内置中文字体内容无效");
}
function binaryStreamObject(value, dictionary = "") {
  const bytes = byteView(value);
  return concatBytes([
    ascii(`<< /Length ${bytes.byteLength}${dictionary ? ` ${dictionary}` : ""} >>\nstream\n`),
    bytes,
    ascii("\nendstream")
  ]);
}
function bundledCjkFontBytes(explicitBytes) {
  if (explicitBytes) return byteView(explicitBytes);
  if (typeof wx === "undefined" || typeof wx.getFileSystemManager !== "function"
      || typeof getCurrentPages !== "function") {
    throw new Error("当前环境无法读取 PDF 内置中文字体");
  }
  const pages = getCurrentPages();
  const route = String(pages[pages.length - 1]?.route || "").replace(/^\/+/, "");
  if (!route) throw new Error("无法确定 PDF 字体所在页面");
  const routeDirectory = route.includes("/") ? route.slice(0, route.lastIndexOf("/")) : route;
  const manager = wx.getFileSystemManager();
  if (typeof manager.readCompressedFileSync !== "function") {
    throw new Error("当前微信版本不支持 PDF 内置中文字体，请升级微信后重试");
  }
  const candidates = [`/${routeDirectory}/${CJK_FONT_FILENAME}`, `${routeDirectory}/${CJK_FONT_FILENAME}`];
  let latestError;
  for (const filePath of candidates) {
    try { return byteView(manager.readCompressedFileSync({ filePath, compressionAlgorithm: "br" })); }
    catch (error) { latestError = error; }
  }
  throw new Error(`PDF 内置中文字体读取失败：${latestError?.errMsg || latestError?.message || "文件不存在"}`);
}
function toUnicodeCMap(mappings) {
  const entries = [...mappings.entries()].sort((left, right) => left[0] - right[0]);
  const lines = [
    "/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /NotoSansCJKsc-Common-UCS def", "/CMapType 2 def",
    "1 begincodespacerange", "<0000> <FFFF>", "endcodespacerange"
  ];
  for (let index = 0; index < entries.length; index += 100) {
    const chunk = entries.slice(index, index + 100);
    lines.push(`${chunk.length} beginbfchar`);
    chunk.forEach(([cid, unicode]) => {
      lines.push(`<${cid.toString(16).padStart(4, "0").toUpperCase()}> <${unicode.toString(16).padStart(4, "0").toUpperCase()}>`);
    });
    lines.push("endbfchar");
  }
  lines.push("endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end");
  return lines.join("\n");
}
function createPdfBytes(pageCommands, cjkFontBytes) {
  const objects = new Map();
  const pageReferences = [];
  const cjkMappings = new Map();
  pageCommands.forEach((commands) => {
    if (commands.cjkMappings) commands.cjkMappings.forEach((unicode, cid) => cjkMappings.set(cid, unicode));
  });
  objects.set(1, ascii("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.set(3, ascii("<< /Type /Font /Subtype /Type0 /BaseFont /NotoSansCJKsc-Regular /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 6 0 R >>"));
  objects.set(4, ascii("<< /Type /Font /Subtype /CIDFontType0 /BaseFont /NotoSansCJKsc-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /DW 1000 >>"));
  objects.set(5, ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"));
  objects.set(6, streamObject(toUnicodeCMap(cjkMappings)));
  objects.set(7, ascii("<< /Type /FontDescriptor /FontName /NotoSansCJKsc-Regular /Flags 4 /FontBBox [-1002 -1048 2928 1808] /ItalicAngle 0 /Ascent 1160 /Descent -288 /CapHeight 733 /StemV 80 /FontFile3 8 0 R >>"));
  objects.set(8, binaryStreamObject(cjkFontBytes, "/Subtype /CIDFontType0C"));
  pageCommands.forEach((commands, index) => {
    const pageNumber = 9 + index * 2;
    const contentNumber = pageNumber + 1;
    pageReferences.push(`${pageNumber} 0 R`);
    addText(commands, `第 ${index + 1} / ${pageCommands.length} 页`, MARGIN, PAGE_HEIGHT - 22, 8, { width: CONTENT_WIDTH, align: "right", color: COLORS.muted });
    objects.set(pageNumber, ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /ProcSet [/PDF /Text] /Font << /F1 3 0 R /F2 5 0 R >> >> /Contents ${contentNumber} 0 R >>`));
    objects.set(contentNumber, streamObject(commands.join("\n")));
  });
  objects.set(2, ascii(`<< /Type /Pages /Count ${pageReferences.length} /Kids [${pageReferences.join(" ")}] >>`));
  const objectCount = 8 + pageCommands.length * 2;
  const chunks = [concatBytes([ascii("%PDF-1.4\n%"), new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]), ascii("\n")])];
  const offsets = new Array(objectCount + 1).fill(0);
  let length = chunks[0].byteLength;
  for (let objectNumber = 1; objectNumber <= objectCount; objectNumber += 1) {
    const chunk = concatBytes([ascii(`${objectNumber} 0 obj\n`), objects.get(objectNumber), ascii("\nendobj\n")]);
    offsets[objectNumber] = length;
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const xrefOffset = length;
  chunks.push(ascii([`xref\n0 ${objectCount + 1}\n`, "0000000000 65535 f \n", ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`), `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`].join("")));
  return concatBytes(chunks);
}

function createGroupedPdf(options = {}) {
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const columns = scaledColumns(Array.isArray(options.columns) ? options.columns : []);
  if (!rows.length) throw new Error("当前查询没有可导出的结果");
  if (!columns.length) throw new Error("PDF 缺少列定义");
  if (rows.length > PDF_EXPORT_MAX_ROWS) throw new Error(`当前结果有 ${rows.length} 条，单次最多导出 ${PDF_EXPORT_MAX_ROWS} 条`);
  const cjkFontBytes = bundledCjkFontBytes(options.cjkFontBytes);
  const groupKey = typeof options.groupKey === "function" ? options.groupKey : (row) => row.storeId || row.storeName;
  const groupLabel = typeof options.groupLabel === "function" ? options.groupLabel : (row) => row.storeName;
  const groups = groupedRows(rows, groupKey, groupLabel);
  const pages = [];
  let page = startPage(clean(options.title, "运营指标查询结果"), "按门店分组", false);
  const criteriaLines = wrapped(clean(options.criteria, `共 ${rows.length} 条`), CONTENT_WIDTH - 8, 8.5);
  criteriaLines.forEach((line, index) => {
    addText(page.commands, line, MARGIN, page.top + index * 12, 8.5, { width: CONTENT_WIDTH, color: COLORS.muted });
  });
  page.top += criteriaLines.length * 12 + 10;
  for (const group of groups) {
    let rowIndex = 0;
    do {
      if (page.top + GROUP_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT > PAGE_HEIGHT - BOTTOM) {
        pages.push(page.commands);
        page = startPage(clean(options.title, "运营指标查询结果"), "查询结果", true);
      }
      drawGroupTitle(page.commands, group.label, group.rows.length, page.top, rowIndex > 0);
      page.top += GROUP_HEIGHT;
      drawHeader(page.commands, columns, page.top);
      page.top += HEADER_HEIGHT;
      while (rowIndex < group.rows.length && page.top + ROW_HEIGHT <= PAGE_HEIGHT - BOTTOM) {
        drawRow(page.commands, columns, group.rows[rowIndex], page.top, rowIndex % 2 === 1);
        page.top += ROW_HEIGHT;
        rowIndex += 1;
      }
      page.top += 8;
      if (rowIndex < group.rows.length) {
        pages.push(page.commands);
        page = startPage(clean(options.title, "运营指标查询结果"), "查询结果", true);
      }
    } while (rowIndex < group.rows.length);
  }
  if (page.commands.length) pages.push(page.commands);
  return { bytes: createPdfBytes(pages, cjkFontBytes), pages: pages.length, rowCount: rows.length, groupCount: groups.length };
}

function wxCall(invoke) { return new Promise((resolve, reject) => invoke(resolve, reject)); }
async function openPdf({ bytes, filename }) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new Error("PDF 内容为空");
  if (typeof wx === "undefined" || !wx.env || !wx.env.USER_DATA_PATH || typeof wx.getFileSystemManager !== "function") {
    throw new Error("当前微信版本无法写入 PDF");
  }
  if (typeof wx.openDocument !== "function") throw new Error("当前微信版本无法打开 PDF，请升级微信后重试");
  const filePath = `${wx.env.USER_DATA_PATH}/${safeFilename(filename)}.pdf`;
  await wxCall((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath, data: bytes, success: resolve, fail: reject }));
  await wxCall((resolve, reject) => wx.openDocument({ filePath, fileType: "pdf", showMenu: true, success: resolve, fail: reject }));
  return filePath;
}

module.exports = { PDF_EXPORT_MAX_ROWS, createGroupedPdf, openPdf, safeFilename };
