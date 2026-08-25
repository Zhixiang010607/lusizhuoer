"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const webReport = require(path.join(root, "hq-dashboard-report.js"));
const miniReport = require(path.join(root, "miniprogram-app", "miniprogram", "services", "hq-dashboard-report.js"));

function reportInput() {
  return {
    startDate: "2026-08-25",
    endDate: "2026-08-25",
    dimensionLabel: "门店",
    metric: "recharge",
    metricLabel: "充值",
    productLabel: "全部项目",
    generatedAt: "2026-08-25 23:30:00",
    productRows: [
      { name: "海洋之蕴", recharge: 50, verification: 2, experience: 1, refund: 0 },
      { name: "露思康辰（已封存）", recharge: 0, verification: 0, experience: 0, refund: 1 }
    ],
    totals: { recharge: 50, verification: 2, experience: 1, refund: 1 },
    rankingRows: [
      { name: "测试门店1", recharge: 50, verification: 2, experience: 0, refund: 1 },
      { name: "历史门店（已封存）", recharge: 1, verification: 0, experience: 0, refund: 0 }
    ],
    rankingTotal: 51
  };
}

function assertVectorPdf(output, client) {
  const bytes = Buffer.from(output.bytes);
  const source = bytes.toString("latin1");
  assert.equal(bytes.subarray(0, 8).toString("ascii"), "%PDF-1.4", `${client} must create a real PDF`);
  assert.ok(output.pages >= 2, `${client} must include both summary and ranking sections`);
  assert.match(source, /\/Subtype \/Type0 \/BaseFont \/STSong-Light/,
    `${client} must use a PDF CJK vector font resource`);
  assert.match(source, /\/Subtype \/Type1 \/BaseFont \/Helvetica/,
    `${client} must keep ASCII and dates in a vector Latin font`);
  assert.match(source, / re [fS]/, `${client} tables must be PDF path objects`);
  assert.match(source, / Tj ET/, `${client} labels must be PDF text objects`);
  assert.doesNotMatch(source, /\/Subtype \/Image|DCTDecode|JPXDecode|\/XObject/,
    `${client} must not rasterize the report into JPEG, PNG, or canvas images`);
  assert.equal((source.match(/\/Type \/Page \/Parent/g) || []).length, output.pages,
    `${client} page tree must match the reported page count`);
}

test("web and mini-program export the same all-vector report contract", () => {
  assertVectorPdf(webReport.createReportPdf(reportInput()), "web");
  assertVectorPdf(miniReport.createReportPdf(reportInput()), "mini-program");
});

test("both clients keep archived projects selectable with an explicit label", () => {
  const web = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const mini = fs.readFileSync(path.join(root, "miniprogram-app", "miniprogram", "pages", "home", "index.js"), "utf8");
  for (const source of [web, mini]) {
    assert.match(source, /product_status[^\n]{0,180}ARCHIVED[^\n]{0,80}（已封存）/,
      "archived projects must remain visible and clearly labelled");
  }
});
