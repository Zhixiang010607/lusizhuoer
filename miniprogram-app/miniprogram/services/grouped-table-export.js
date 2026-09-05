const EXPORT_BATCH_SIZE = 100;
const EXPORT_MAX_ROWS = 1000;

function clean(value) { return String(value ?? "").trim(); }
function safeFilename(value) {
  return clean(value || "客户查询结果")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80) || "客户查询结果";
}
function validXmlText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
function visualUnits(value) {
  return Array.from(String(value ?? "")).reduce(
    (sum, character) => sum + (character.codePointAt(0) <= 0x7f ? 1 : 2), 0
  );
}
function utf8Bytes(value) {
  const bytes = [];
  for (const symbol of String(value ?? "")) {
    const code = symbol.codePointAt(0);
    if (code <= 0x7f) bytes.push(code);
    else if (code <= 0x7ff) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code <= 0xffff) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return new Uint8Array(bytes);
}
function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}
function binary(size, entries = []) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  for (const [offset, value, width] of entries) {
    if (width === 2) view.setUint16(offset, value, true);
    else view.setUint32(offset, value >>> 0, true);
  }
  return bytes;
}

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = utf8Bytes(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : utf8Bytes(entry.data);
    const checksum = crc32(data);
    const localHeader = binary(30, [
      [0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2],
      [10, 0, 2], [12, 33, 2], [14, checksum, 4], [18, data.byteLength, 4],
      [22, data.byteLength, 4], [26, name.byteLength, 2], [28, 0, 2]
    ]);
    localParts.push(localHeader, name, data);
    const centralHeader = binary(46, [
      [0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2],
      [12, 0, 2], [14, 33, 2], [16, checksum, 4], [20, data.byteLength, 4],
      [24, data.byteLength, 4], [28, name.byteLength, 2], [30, 0, 2], [32, 0, 2],
      [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, localOffset, 4]
    ]);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.byteLength + name.byteLength + data.byteLength;
  }
  const central = concatBytes(centralParts);
  const end = binary(22, [
    [0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, entries.length, 2],
    [10, entries.length, 2], [12, central.byteLength, 4], [16, localOffset, 4], [20, 0, 2]
  ]);
  return concatBytes([...localParts, central, end]);
}

function columnName(index) {
  let value = Number(index) + 1;
  let output = "";
  while (value > 0) { value -= 1; output = String.fromCharCode(65 + (value % 26)) + output; value = Math.floor(value / 26); }
  return output;
}
function inlineCell(reference, value, style) {
  return `<c r="${reference}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${validXmlText(value)}</t></is></c>`;
}
function valueCell(reference, value, style, type) {
  if (type === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? `<c r="${reference}" s="${style}"><v>${number}</v></c>` : inlineCell(reference, "—", 5);
  }
  return inlineCell(reference, value === undefined || value === null || value === "" ? "—" : value, style);
}
function compareText(left, right) {
  try { return clean(left).localeCompare(clean(right), "zh-CN"); } catch (_) { return clean(left).localeCompare(clean(right)); }
}
function groupedRows(rows, groupKey, groupLabel) {
  const groups = new Map();
  for (const row of rows) {
    const key = clean(groupKey(row)) || clean(groupLabel(row)) || "未命名门店";
    const label = clean(groupLabel(row)) || "未命名门店";
    if (!groups.has(key)) groups.set(key, { key, label, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].sort((left, right) => compareText(left.label, right.label) || compareText(left.key, right.key));
}
function safeSheetName(value) {
  return clean(value || "客户查询").replace(/[\\/*?:\[\]]/g, "-").slice(0, 31) || "客户查询";
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts>
  <fonts count="4"><font><sz val="11"/><name val="Microsoft YaHei"/><color rgb="FF302A22"/></font><font><b/><sz val="11"/><name val="Microsoft YaHei"/><color rgb="FF5B4328"/></font><font><b/><sz val="18"/><name val="Microsoft YaHei"/><color rgb="FF302A22"/></font><font><b/><sz val="11"/><name val="Microsoft YaHei"/><color rgb="FFFFFDF8"/></font></fonts>
  <fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2E2C5"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF80602F"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFAF3"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF8ED"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFE5D7C2"/></left><right style="thin"><color rgb="FFE5D7C2"/></right><top style="thin"><color rgb="FFE5D7C2"/></top><bottom style="thin"><color rgb="FFE5D7C2"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="2" fillId="5" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function worksheetXml({ title, criteria, columns, rows, groupKey, groupLabel }) {
  const groups = groupedRows(rows, groupKey, groupLabel);
  const lastColumn = columnName(columns.length - 1);
  const xmlRows = [];
  const merges = [`A1:${lastColumn}1`, `A2:${lastColumn}2`];
  const criteriaCapacity = Math.max(20, columns.reduce((sum, column) => sum + Number(column.width || 16), 0));
  const criteriaLineCount = Math.max(1, Math.ceil(visualUnits(criteria) / criteriaCapacity));
  const criteriaHeight = 8 + criteriaLineCount * 18;
  xmlRows.push(`<row r="1" ht="32" customHeight="1">${inlineCell("A1", title, 1)}</row>`);
  xmlRows.push(`<row r="2" ht="${criteriaHeight}" customHeight="1">${inlineCell("A2", criteria, 7)}</row>`);
  xmlRows.push('<row r="3" ht="9" customHeight="1"/>');
  let rowNumber = 4;
  for (const group of groups) {
    const groupReference = `A${rowNumber}:${lastColumn}${rowNumber}`;
    merges.push(groupReference);
    xmlRows.push(`<row r="${rowNumber}" ht="24" customHeight="1">${inlineCell(`A${rowNumber}`, `门店：${group.label}（${group.rows.length} 条）`, 3)}</row>`);
    rowNumber += 1;
    const headers = columns.map((column, index) => inlineCell(`${columnName(index)}${rowNumber}`, column.header, 4)).join("");
    xmlRows.push(`<row r="${rowNumber}" ht="24" customHeight="1">${headers}</row>`);
    rowNumber += 1;
    for (const row of group.rows) {
      const cells = columns.map((column, index) => valueCell(
        `${columnName(index)}${rowNumber}`,
        typeof column.value === "function" ? column.value(row) : row[column.key],
        column.type === "number" ? 6 : 5,
        column.type
      )).join("");
      xmlRows.push(`<row r="${rowNumber}" ht="22" customHeight="1">${cells}</row>`);
      rowNumber += 1;
    }
    xmlRows.push(`<row r="${rowNumber}" ht="9" customHeight="1"/>`);
    rowNumber += 1;
  }
  const lastRow = Math.max(3, rowNumber - 1);
  const columnXml = columns.map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${Number(column.width || 16)}" customWidth="1"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastColumn}${lastRow}"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${columnXml}</cols><sheetData>${xmlRows.join("")}</sheetData><mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}

function createGroupedWorkbook(options = {}) {
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const columns = Array.isArray(options.columns) ? options.columns : [];
  if (!rows.length) throw new Error("当前查询没有可导出的客户");
  if (!columns.length) throw new Error("导出表格缺少列定义");
  if (rows.length > EXPORT_MAX_ROWS) throw new Error(`当前结果有 ${rows.length} 条，单次最多导出 ${EXPORT_MAX_ROWS} 条`);
  const sheetName = safeSheetName(options.sheetName || options.title);
  const sheetXml = worksheetXml({
    title: clean(options.title) || "客户查询结果",
    criteria: clean(options.criteria) || `共 ${rows.length} 条`,
    columns,
    rows,
    groupKey: typeof options.groupKey === "function" ? options.groupKey : (row) => row.storeId || row.storeName,
    groupLabel: typeof options.groupLabel === "function" ? options.groupLabel : (row) => row.storeName
  });
  const entries = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="${validXmlText(sheetName)}" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="0"/></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: stylesXml() },
    { name: "xl/worksheets/sheet1.xml", data: sheetXml }
  ];
  const groups = groupedRows(rows,
    typeof options.groupKey === "function" ? options.groupKey : (row) => row.storeId || row.storeName,
    typeof options.groupLabel === "function" ? options.groupLabel : (row) => row.storeName);
  return { bytes: zipStore(entries), rowCount: rows.length, groupCount: groups.length, sheetName };
}

function wxCall(invoke) { return new Promise((resolve, reject) => invoke(resolve, reject)); }
async function openWorkbook({ bytes, filename }) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new Error("导出表格内容为空");
  if (typeof wx === "undefined" || !wx.env || !wx.env.USER_DATA_PATH || typeof wx.getFileSystemManager !== "function") {
    throw new Error("当前微信版本无法写入表格文件");
  }
  if (typeof wx.openDocument !== "function") throw new Error("当前微信版本无法打开 Excel，请升级微信后重试");
  const filePath = `${wx.env.USER_DATA_PATH}/${safeFilename(filename)}.xlsx`;
  await wxCall((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath, data: bytes, success: resolve, fail: reject }));
  await wxCall((resolve, reject) => wx.openDocument({ filePath, fileType: "xlsx", showMenu: true, success: resolve, fail: reject }));
  return filePath;
}

module.exports = {
  EXPORT_BATCH_SIZE,
  EXPORT_MAX_ROWS,
  createGroupedWorkbook,
  openWorkbook,
  safeFilename
};
