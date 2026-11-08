"use strict";

// Independent mini-program implementation. It intentionally does not import
// the web exporter, although both clients share the same vector PDF contract.
const PAGE_WIDTH = 841.89;
const PAGE_HEIGHT = 595.28;
const MARGIN = 34;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 30;
const COLORS = Object.freeze({
  background: [1, 0.984, 0.953], band: [0.725, 0.541, 0.239], dark: [0.227, 0.18, 0.133],
  muted: [0.404, 0.349, 0.278], pale: [0.957, 0.906, 0.816], paleAlt: [0.99, 0.963, 0.918],
  line: [0.847, 0.773, 0.639], white: [1, 1, 1]
});
function clean(value, fallback = "—") { const output = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim(); return output || fallback; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function decimal(value) { return Number(Number(value).toFixed(3)).toString(); }
function color(value) { return value.map(decimal).join(" "); }
function pdfText(value) { let output = ""; for (const character of Array.from(clean(value, ""))) { const point = character.codePointAt(0); output += (point <= 0xffff ? point : 0x003f).toString(16).padStart(4, "0").toUpperCase(); } return `<${output || "0020"}>`; }
function pdfAsciiText(value) { let output = ""; for (const character of Array.from(clean(value, ""))) { const point = character.codePointAt(0); output += (point >= 0x20 && point <= 0xff ? point : 0x3f).toString(16).padStart(2, "0").toUpperCase(); } return `<${output || "20"}>`; }
function textRuns(value) { const runs = []; for (const character of Array.from(value)) { const ascii = character.codePointAt(0) <= 0xff; const previous = runs[runs.length - 1]; if (previous && previous.ascii === ascii) previous.value += character; else runs.push({ ascii, value: character }); } return runs; }
const HELVETICA_WIDTHS = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
function visualUnits(value) { return Array.from(String(value || "")).reduce((sum, character) => sum + (character.codePointAt(0) === 183 ? .278 : character.codePointAt(0) >= 32 && character.codePointAt(0) <= 126 ? HELVETICA_WIDTHS[character.codePointAt(0)-32]/1000 : 1), 0); }
function fitted(value, width, size) { const source = clean(value); const maximum = Math.max(1, width / Math.max(1, size)); if (visualUnits(source) <= maximum) return source; let output = ""; for (const character of Array.from(source)) { if (visualUnits(`${output}${character}…`) > maximum) break; output += character; } return `${output}…`; }
function safeFilename(value) { return clean(value, "露思卓儿总部业务统计报表").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").slice(0, 100); }
function addFillRect(commands, x, top, width, height, fill) { commands.push(`${color(fill)} rg ${decimal(x)} ${decimal(PAGE_HEIGHT - top - height)} ${decimal(width)} ${decimal(height)} re f`); }
function addStrokeRect(commands, x, top, width, height, stroke = COLORS.line, lineWidth = 0.6) { commands.push(`${color(stroke)} RG ${decimal(lineWidth)} w ${decimal(x)} ${decimal(PAGE_HEIGHT - top - height)} ${decimal(width)} ${decimal(height)} re S`); }
function addText(commands, value, x, top, size = 10, options = {}) { const width = Number(options.width || 0); const output = width ? fitted(value, Math.max(1, width - 10), size) : clean(value); let offset = 0; if (width && options.align === "center") offset = Math.max(0, (width - visualUnits(output) * size) / 2); if (width && options.align === "right") offset = Math.max(0, width - visualUnits(output) * size - 6); let cursor = x + offset; textRuns(output).forEach((run) => { commands.push(`BT /${run.ascii ? "F2" : "F1"} ${decimal(size)} Tf ${color(options.color || COLORS.dark)} rg ${decimal(cursor)} ${decimal(PAGE_HEIGHT - top - size)} Td ${run.ascii ? pdfAsciiText(run.value) : pdfText(run.value)} Tj ET`); cursor += visualUnits(run.value) * size; }); }
function startPage(sectionTitle, continuation = false, metadata = null) { const commands = []; addFillRect(commands, 0, 0, PAGE_WIDTH, PAGE_HEIGHT, COLORS.background); addFillRect(commands, 0, 0, PAGE_WIDTH, 10, COLORS.band); addText(commands, "露思卓儿总部业务统计报表", MARGIN, 24, 18); addText(commands, continuation ? `${sectionTitle}（续）` : sectionTitle, MARGIN, 54, 12, { color: COLORS.band }); let tableTop = 82; if (metadata) { addFillRect(commands, MARGIN, 78, CONTENT_WIDTH, 55, COLORS.paleAlt); addStrokeRect(commands, MARGIN, 78, CONTENT_WIDTH, 55); addText(commands, `时间范围：${clean(metadata.startDate)} 至 ${clean(metadata.endDate)}（Asia/Shanghai）`, MARGIN + 12, 90, 9, { width: CONTENT_WIDTH / 2 - 18 }); addText(commands, `排名对象：${clean(metadata.dimensionLabel)}　排序：${clean(metadata.metricLabel)}`, MARGIN + CONTENT_WIDTH / 2, 90, 9, { width: CONTENT_WIDTH / 2 - 12 }); addText(commands, `项目范围：${clean(metadata.productLabel)}`, MARGIN + 12, 111, 9, { width: CONTENT_WIDTH / 2 - 18 }); addText(commands, `生成时间：${clean(metadata.generatedAt)}`, MARGIN + CONTENT_WIDTH / 2, 111, 9, { width: CONTENT_WIDTH / 2 - 12 }); tableTop = 149; } return { commands, tableTop }; }
function drawTable(commands, columns, rows, top) { let x = MARGIN; addFillRect(commands, MARGIN, top, CONTENT_WIDTH, HEADER_HEIGHT, COLORS.pale); columns.forEach((column) => { addStrokeRect(commands, x, top, column.width, HEADER_HEIGHT); addText(commands, column.label, x + 5, top + 9, 10.5, { width: column.width - 10, align: "right" }); x += column.width; }); rows.forEach((row, rowIndex) => { x = MARGIN; const rowTop = top + HEADER_HEIGHT + rowIndex * ROW_HEIGHT; addFillRect(commands, MARGIN, rowTop, CONTENT_WIDTH, ROW_HEIGHT, row.__total ? COLORS.pale : (rowIndex % 2 ? COLORS.paleAlt : COLORS.white)); columns.forEach((column) => { addStrokeRect(commands, x, rowTop, column.width, ROW_HEIGHT); addText(commands, row[column.key], x + 5, rowTop + 8, row.__total ? 11 : 10.5, { width: column.width - 10, align: "right", color: row.__total ? COLORS.dark : COLORS.muted }); x += column.width; }); }); }
function rowsPerPage(tableTop) { return Math.max(1, Math.floor((PAGE_HEIGHT - tableTop - HEADER_HEIGHT - 38) / ROW_HEIGHT)); }
function tablePages(sectionTitle, columns, rows, metadata = null) { const pages = []; let index = 0; do { const page = startPage(sectionTitle, index > 0, index === 0 ? metadata : null); const size = rowsPerPage(page.tableTop); const chunk = rows.slice(index, index + size); drawTable(page.commands, columns, chunk.length ? chunk : [{ name: "暂无数据" }], page.tableTop); pages.push(page.commands); index += size; } while (index < rows.length); return pages; }
function ascii(value) { const text = String(value); const output = new Uint8Array(text.length); for (let index = 0; index < text.length; index += 1) output[index] = text.charCodeAt(index) & 0xff; return output; }
function concatBytes(parts) { const total = parts.reduce((sum, part) => sum + part.byteLength, 0); const output = new Uint8Array(total); let offset = 0; parts.forEach((part) => { output.set(part, offset); offset += part.byteLength; }); return output; }
function streamObject(value) { const bytes = ascii(value); return concatBytes([ascii(`<< /Length ${bytes.byteLength} >>\nstream\n`), bytes, ascii("\nendstream")]); }
function createLegacyPdfBytes(pageCommands) { const objects = new Map(); const pageReferences = []; objects.set(1, ascii("<< /Type /Catalog /Pages 2 0 R >>")); objects.set(3, ascii("<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>")); objects.set(4, ascii("<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 5 >> /DW 1000 >>")); objects.set(5, ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")); pageCommands.forEach((commands, index) => { const pageNumber = 6 + index * 2; const contentNumber = pageNumber + 1; pageReferences.push(`${pageNumber} 0 R`); addText(commands, `第 ${index + 1} / ${pageCommands.length} 页`, MARGIN, PAGE_HEIGHT - 24, 9, { width: CONTENT_WIDTH, align: "right", color: COLORS.muted }); objects.set(pageNumber, ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /ProcSet [/PDF /Text] /Font << /F1 3 0 R /F2 5 0 R >> >> /Contents ${contentNumber} 0 R >>`)); objects.set(contentNumber, streamObject(commands.join("\n"))); }); objects.set(2, ascii(`<< /Type /Pages /Count ${pageReferences.length} /Kids [${pageReferences.join(" ")}] >>`)); const objectCount = 5 + pageCommands.length * 2; const chunks = [concatBytes([ascii("%PDF-1.4\n%"), new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]), ascii("\n")])]; const offsets = new Array(objectCount + 1).fill(0); let length = chunks[0].byteLength; for (let objectNumber = 1; objectNumber <= objectCount; objectNumber += 1) { const chunk = concatBytes([ascii(`${objectNumber} 0 obj\n`), objects.get(objectNumber), ascii("\nendobj\n")]); offsets[objectNumber] = length; chunks.push(chunk); length += chunk.byteLength; } const xrefOffset = length; chunks.push(ascii([`xref\n0 ${objectCount + 1}\n`, "0000000000 65535 f \n", ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`), `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`].join(""))); return concatBytes(chunks); }
function createPdfBytes(commands, fontBytes) {
  if (!fontBytes) return createLegacyPdfBytes(commands);
  for (const page of commands) {
    page.cjkMappings = new Map();
    for (const command of page) {
      if (!command.startsWith("BT /F1 ")) continue;
      const hex = command.match(/<([0-9A-F]+)> Tj/);
      if (hex) for (let index = 0; index < hex[1].length; index += 4) {
        const cid = parseInt(hex[1].slice(index, index + 4), 16); page.cjkMappings.set(cid, cid);
      }
    }
  }
  return require("./grouped-table-pdf").createVectorPdf(commands, fontBytes);
}
function overviewPages(summaryRows, rankingRows, report) {
  const pages=[];
  const metadata=[`${clean(report.startDate)} 至 ${clean(report.endDate)} · 北京时间`, `${clean(report.dimensionLabel)}排名 · ${clean(report.productLabel)} · 按${clean(report.metricLabel)}次数降序`];
  function fresh(continued=false){const commands=[];addFillRect(commands,0,0,PAGE_WIDTH,PAGE_HEIGHT,COLORS.white);addFillRect(commands,42,32,4,24,COLORS.band);addText(commands,"总部业务总览",56,29,21);metadata.forEach((v,i)=>addText(commands,v,42,66+i*18,11,{color:COLORS.muted}));return{commands,top:119};}
  function lines(value,width){const out=[];let line="";for(const ch of Array.from(clean(value))){if(line&&visualUnits(line+ch)*13>width-20){out.push(line);line=ch;}else line+=ch;}out.push(line);return out;}
  let page=fresh();
  function section(title,columns,rows){
    const tableWidth=columns.reduce((n,c)=>n+c.width,0);
    let index=0,continuation=false;
    do{
      if(page.top+85>PAGE_HEIGHT-42){pages.push(page.commands);page=fresh(true);}
      addText(page.commands,`${title}${continuation?"（续）":""}`,42,page.top,15,{color:COLORS.band});page.top+=27;
      let x=42;columns.forEach(c=>{addFillRect(page.commands,x,page.top,c.width,32,COLORS.pale);addText(page.commands,c.label,x+8,page.top+8,12,{width:c.width-16,align:"right"});x+=c.width;});page.top+=32;
      while(index<rows.length){const row=rows[index],cells=columns.map(c=>lines(row[c.key],c.width));const height=Math.max(34,Math.max(...cells.map(v=>v.length))*18+16);
        if(page.top+height>PAGE_HEIGHT-42)break;
        if(row.__total)addFillRect(page.commands,42,page.top,tableWidth,height,COLORS.paleAlt);
        let left=42;columns.forEach((c,i)=>{cells[i].forEach((v,j)=>addText(page.commands,v,left+8,page.top+(height-cells[i].length*18)/2+j*18,13,{width:c.width-16,align:"right",color:COLORS.dark}));left+=c.width;});
        page.commands.push(`${color(COLORS.line)} RG 0.4 w 42 ${decimal(PAGE_HEIGHT-page.top-height)} m ${decimal(42+tableWidth)} ${decimal(PAGE_HEIGHT-page.top-height)} l S`);
        page.top+=height;index++;
      }
      if(index<rows.length){pages.push(page.commands);page=fresh(true);continuation=true;}
    }while(index<rows.length);
    page.top+=24;
  }
  const metricColumns=[{key:"verification",label:"核销",width:75,numeric:true},{key:"recharge",label:"充值",width:75,numeric:true},{key:"experience",label:"体验",width:75,numeric:true},{key:"refund",label:"退费",width:75,numeric:true}];
  section("项目汇总",[{key:"name",label:"项目",width:185},...metricColumns],summaryRows);
  section(`完整排名（${rankingRows.length}位）`,[{key:"rank",label:"名次",width:50,numeric:true},{key:"name",label:clean(report.dimensionLabel,"分类对象"),width:190},...metricColumns,{key:"share",label:`${clean(report.metricLabel,"业务")}占比`,width:98,numeric:true}],rankingRows.length?rankingRows:[{name:"暂无数据"}]);
  pages.push(page.commands);return pages;
}

function createReportPdf(report = {}) {
  const productRows = Array.isArray(report.productRows) ? report.productRows : [];
  const totals = { recharge: 0, verification: 0, experience: 0, refund: 0 };
  const productIds = new Set(), rankingIds = new Set(), metrics = Object.keys(totals);
  function unique(row, ids, key) {
    const id = String(row[key] !== undefined && row[key] !== null ? row[key] : row.entityId !== undefined && row.entityId !== null ? row.entityId : "");
    if (!id) return;
    if (ids.has(id)) throw new Error("导出数据出现重复，请重新读取后导出。");
    ids.add(id);
  }
  productRows.forEach(row => {
    unique(row, productIds, "productId");
    metrics.forEach(key => { totals[key] += number(row[key]); });
  });
  const sourceRanking = Array.isArray(report.rankingRows) ? report.rankingRows : [];
  sourceRanking.forEach(row => unique(row, rankingIds, "entityId"));
  const metric = metrics.includes(report.metric) ? report.metric : "recharge";
  const loadedRankingTotal = sourceRanking.reduce((sum, row) => sum + number(row[metric]), 0);
  if (report.rankingTotal !== undefined && loadedRankingTotal !== number(report.rankingTotal)) {
    throw new Error("导出数据已变化，排名明细与合计不一致，请重新读取后导出。");
  }
 const summaryRows = productRows.map((row) => ({ name: clean(row.name || row.productName), verification: String(number(row.verification)), recharge: String(number(row.recharge)), experience: String(number(row.experience)), refund: String(number(row.refund)) })); summaryRows.push({ name: "合计", verification: String(number(totals.verification)), recharge: String(number(totals.recharge)), experience: String(number(totals.experience)), refund: String(number(totals.refund)), __total: true }); const metadata = { startDate: report.startDate, endDate: report.endDate, dimensionLabel: report.dimensionLabel, metricLabel: report.metricLabel, productLabel: report.productLabel, generatedAt: report.generatedAt }; const summaryColumns = [{ key: "name", label: "项目", width: CONTENT_WIDTH - 109 * 4 }, { key: "verification", label: "核销", width: 109, numeric: true }, { key: "recharge", label: "充值", width: 109, numeric: true }, { key: "experience", label: "体验", width: 109, numeric: true }, { key: "refund", label: "退费", width: 109, numeric: true }]; const rankingTotal = Math.max(1, loadedRankingTotal); const rankingRows = sourceRanking.map((row, index) => ({ rank: String(index + 1), name: clean(row.name), dimension: clean(report.dimensionLabel), recharge: String(number(row.recharge)), verification: String(number(row.verification)), experience: String(number(row.experience)), refund: String(number(row.refund)), share: `${(number(row[metric]) / rankingTotal * 100).toFixed(1)}%` })); const rankingColumns = [{ key: "rank", label: "排名", width: 50, numeric: true }, { key: "name", label: clean(report.dimensionLabel, "分类对象"), width: CONTENT_WIDTH - 50 - 68 - 67 * 4 - 134 }, { key: "dimension", label: "维度", width: 68, align: "center" }, { key: "recharge", label: "充值", width: 67, numeric: true }, { key: "verification", label: "核销", width: 67, numeric: true }, { key: "experience", label: "体验", width: 67, numeric: true }, { key: "refund", label: "退费", width: 67, numeric: true }, { key: "share", label: `${clean(report.metricLabel, "业务")}占比`, width: 134, numeric: true }]; const pages = overviewPages(summaryRows, rankingRows, report); return { bytes: createPdfBytes(pages, report.cjkFontBytes), pages: pages.length }; }
module.exports = Object.freeze({ createReportPdf, safeFilename, loadCjkFontBytes: () => require("./grouped-table-pdf").loadCjkFontBytes() });
