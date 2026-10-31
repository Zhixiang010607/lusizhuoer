"use strict";
// Isolated label preview: production functions/CSS, synthetic records, no SDK or session.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const root = path.resolve(__dirname, "..");
function extract(file, name, next, scope = {}) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const start = source.indexOf(`function ${name}(`), end = source.indexOf(next, start);
  if (start < 0 || end <= start) throw Error(name);
  const context = { ...scope };
  vm.runInNewContext(source.slice(start, end) + `\nthis.run=${name};`, context);
  return context.run;
}
const tag = extract("query.js", "verificationTypeTag", "    function rechargeTypeTag");
const clean = value => String(value ?? "").trim();
const detail = extract("business-detail.js", "normalizeDatabaseOrder", "  function normalizeTeacherOrder", {
  type: "verification", clean, field: (row, snake, camel) => row[snake] ?? row[camel] ?? "", normalizeProductGifts: () => []
});
const target = fs.mkdtempSync(path.join(os.tmpdir(), "lusizhuoer-supplement-labels-"));
fs.copyFileSync(path.join(root, "styles.css"), path.join(target, "styles.css"));
const rows = [["正常已完成", "NORMAL", "APPROVED"], ["补录审核通过", "SUPPLEMENT", "APPROVED"], ["体验已完成", "EXPERIENCE", "APPROVED"], ["补录待审", "SUPPLEMENT", "PENDING"], ["补录驳回", "SUPPLEMENT", "REJECTED"]];
fs.writeFileSync(path.join(target, "index.html"), `<!doctype html><html lang="zh-CN" data-auth-ready><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>补录只读分类验收</title><link rel="stylesheet" href="styles.css"><body class="store-record-query" style="padding:24px;margin:0"><main style="margin:0"><section class="panel table-card query-results store-record-results"><div class="panel-heading"><h2>补录只读分类验收（纯合成数据）</h2></div><div class="table-scroll"><table class="record-query-results-table"><thead><tr><th>测试来源</th><th>查询类型</th><th>详情类型</th><th>内部类型（仅测试）</th></tr></thead><tbody>${rows.map(([label, type, status]) => `<tr><td>${label}</td><td>${tag(type, status)}</td><td>${detail({ original_type: type, original_status: status }).originalKind}</td><td>${type}</td></tr>`).join("")}</tbody></table></div></section></main></body></html>`);
console.log(JSON.stringify({ project: target, production: ["styles.css", "query.js:verificationTypeTag", "business-detail.js:normalizeDatabaseOrder"], writes: "none", businessNetwork: "none" }));
