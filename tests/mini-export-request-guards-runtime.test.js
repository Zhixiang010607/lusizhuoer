"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app/miniprogram");
const services = path.join(mini, "services");
const excel = require(path.join(services, "grouped-table-export"));
const pdf = require(path.join(services, "grouped-table-pdf"));
const font = zlib.brotliDecompressSync(fs.readFileSync(path.join(mini,
  "packages/report-font/NotoSansCJKsc-Common-Identity.br")));
const read = file => fs.readFileSync(path.join(root, file), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function device(t, holdWrite = false) {
  const previous = global.wx;
  const writes = [], opens = [], writing = deferred();
  global.wx = {
    env: { USER_DATA_PATH: "/synthetic-export" },
    getFileSystemManager: () => ({ writeFile(options) {
      assert(options.data instanceof ArrayBuffer);
      writes.push(options);
      writing.resolve();
      if (!holdWrite) options.success({});
    } }),
    openDocument(options) { opens.push(options); options.success({}); }
  };
  t.after(() => { if (previous === undefined) delete global.wx; else global.wx = previous; });
  return { writes, opens, writing };
}

function client(api, fontGate = null) {
  let session = { uid: "synthetic-hq-a", role: "hq" };
  const sessionApi = { readSession: () => session, requireSession: () => session };
  const fontStarted = deferred();
  const pdfApi = { ...pdf, loadCjkFontBytes() {
    fontStarted.resolve();
    return fontGate ? fontGate.promise : Promise.resolve(font);
  } };
  function dependency(id) {
    if (id.endsWith("/api")) return api;
    if (id.endsWith("/session")) return sessionApi;
    if (id.endsWith("/teacher-team")) return {};
    if (id.endsWith("/grouped-table-pdf")) return pdfApi;
    return require(path.join(services, path.basename(id)));
  }
  function load(relative, isPage = false) {
    const module = { exports: {} };
    let definition;
    vm.runInNewContext(fs.readFileSync(path.join(mini, relative), "utf8"), {
      module, Uint8Array, ArrayBuffer, wx: global.wx, require: dependency,
      Page(value) { definition = value; }
    });
    if (!isPage) return module.exports;
    definition ||= module.exports.createRatingPage();
    const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)),
      setData(patch, done) { Object.assign(this.data, patch); done?.(); } };
    Object.assign(page.data, { session, searched: true, total: 2,
      minimumDays: "30", remainingBelow: "5", selectedScores: [4] });
    return page;
  }
  return { load, fontStarted, changeAccount() { session = { uid: "synthetic-hq-b", role: "hq" }; } };
}

function productServer(rows) {
  const source = read("cloudfunctions/staffAccount/index.js");
  const numericStart = source.indexOf("function numericId(");
  const numericEnd = source.indexOf("\nfunction storeInputFromEvent", numericStart);
  const start = source.indexOf("async function listRetailProductPurchaseReviews(");
  const end = source.indexOf("\nasync function reviewRetailProductPurchase", start);
  assert(numericStart >= 0 && numericEnd > numericStart && start >= 0 && end > start);
  const statements = [], requests = [];
  const sandbox = {
    requireReviewer() {}, requireRetailProductPurchaseSchema: async () => {},
    hasRechargeProductGiftSchema: async () => true, strictDashboardDate: value => value,
    sqlText: value => "'" + String(value).replaceAll("'", "''") + "'",
    fail(message, code) { throw Object.assign(Error(message), { code }); },
    executeSql: async sql => { statements.push(sql); return rows; }
  };
  vm.runInNewContext(source.slice(numericStart, numericEnd) + source.slice(start, end) +
    "\nthis.run = listRetailProductPurchaseReviews;", sandbox);
  return { statements, requests, async callStaff(action, payload) {
    assert.equal(action, "listRetailProductPurchaseReviews");
    requests.push(payload);
    return sandbox.run({}, payload);
  } };
}

for (const format of ["pdf", "excel"]) {
  test(`product ${format}: real backend validator accepts ALL and preserves selected filters`, async t => {
    const d = device(t);
    const server = productServer([1, 2].map(id => ({ id: String(id), source_type: "GIFT",
      source_line_id: String(id), record_code: "RC261108000001", store_name: "合成门店",
      customer_name: "同一合成客户", product_name_snapshot: "合成产品", unit_count: 1 })));
    const c = client(server), service = c.load("services/query-report-export.js");
    for (const productId of ["ALL", "", undefined, "7"]) {
      const payload = { productId, statusCategory: "APPROVED", sourceType: "GIFT", storeId: "3",
        customerName: "同一合成客户", startDate: "2026-11-01", endDate: "2026-11-08" };
      const before = { ...payload };
      const p = { data: {}, setData(value) { Object.assign(this.data, value); } };
      await service.exportPage(p, "PRODUCT_PURCHASE", payload, { format });
      assert.equal(p.data.error, false, p.data.message);
      assert.equal(p.data.message, "已导出 2 条");
      const request = server.requests.at(-1), sql = server.statements.at(-1);
      assert.equal(Object.hasOwn(request, "productId"), false, "do not retain the backend fallback ID");
      assert.equal(request.retailProductId, productId === "7" ? "7" : "");
      assert.equal(request.status, "APPROVED");
      assert.equal(request.sourceType, "GIFT");
      assert.match(sql, /gift\.store_id = 3/);
      assert.match(sql, /record_status = 'APPROVED'/);
      if (productId === "7") assert.match(sql, /gift\.retail_product_id = 7/);
      else assert.doesNotMatch(sql, /retail_product_id =/);
      assert.deepEqual(payload, before);
    }
    assert.equal(d.opens.length, 4);
    assert(d.opens.every(item => item.fileType === (format === "pdf" ? "pdf" : "xlsx")));
  });

  for (const change of ["account", "filter", "unload"]) {
    test(`query ${format}: ${change} during file writing prevents opening`, async t => {
      const d = device(t, true);
      const c = client({ callFace: async () => ({ exportAll: true, total: 1,
        customers: [{ customerCode: "SYNTHETIC-C1", customerName: "合成客户", storeName: "合成门店" }] }) });
      const service = c.load("services/query-report-export.js");
      const p = { data: {}, setData(value) { Object.assign(this.data, value); } };
      let current = true;
      const task = service.exportPage(p, "CUSTOMER", {}, { format, valid: () => current });
      await Promise.race([d.writing.promise, task.then(() => assert.fail("export never reached writing"))]);
      if (change === "account") c.changeAccount();
      else if (change === "filter") current = false;
      else p._unloaded = true;
      d.writes[0].success({});
      await task;
      assert.equal(d.opens.length, 0);
      assert.doesNotMatch(p.data.message, /已导出/);
    });
  }

  test(`${format} opener rejects an already invalid export before writing`, async t => {
    const d = device(t);
    await (format === "pdf" ? pdf.openPdf : excel.openWorkbook)({ bytes: new Uint8Array([1]),
      filename: "合成测试", valid: () => false });
    assert.equal(d.writes.length, 0);
    assert.equal(d.opens.length, 0);
  });
}

const pages = [
  ["inactive-customers/index.js", { summary: { selectedTotal: 2 }, exportCustomers: [1, 2].map(id => ({
    customerCode: `SYNTHETIC-C${id}`, customerName: "合成客户", storeId: "1", storeName: "合成门店",
    baselineSource: "CUSTOMER_CREATED", balanceCategory: "ZERO", daysSince: 30 })) }],
  ["low-balance-customers/index.js", { summary: { selectedTotal: 2 }, exportBalances: [1, 2].map(id => ({
    customerCode: "SYNTHETIC-C1", customerName: "同一合成客户", productId: String(id),
    productName: "合成项目", storeId: "1", storeName: "合成门店", remainingCount: 0 })) }],
  ["rating-analysis/rating-page.js", { total: 2, orders: [1, 2].map(id => ({ id: String(id),
    recordCode: `SYNTHETIC-V${id}`, customerCode: "SYNTHETIC-C1", customerName: "同一合成客户",
    teacherId: "1", teacherName: "同一合成老师", storeId: "1", storeName: "合成门店", effectiveScore: 4 })) }]
];

for (const [filename, result] of pages) {
  function setup(requestGate = null, fontGate = null) {
    const readResult = async () => requestGate ? requestGate.promise : result;
    const c = client({ callFace: readResult, callRating: readResult }, fontGate);
    return { c, p: c.load(`pages/${filename}`, true) };
  }
  function invalidate(p, c, change) {
    if (change === "account") c.changeAccount();
    else if (change === "filter") p.clearResults();
    else p.onUnload();
  }

  test(`${filename}: changed account while fetching prevents export`, async t => {
    const d = device(t), request = deferred(), { c, p } = setup(request);
    const task = p.exportAll("excel");
    c.changeAccount(); request.resolve(result); await task;
    assert.equal(d.writes.length, 0);
    assert.equal(d.opens.length, 0);
    assert.equal(p.data.exporting, false);
  });

  for (const change of ["account", "filter", "unload"]) {
    test(`${filename}: ${change} during font loading prevents writing/opening`, async t => {
      const d = device(t), fontGate = deferred(), { c, p } = setup(null, fontGate);
      const task = p.exportAll("pdf");
      await Promise.race([c.fontStarted.promise, task.then(() => assert.fail("export never loaded fonts"))]);
      invalidate(p, c, change); fontGate.resolve(font); await task;
      assert.equal(d.writes.length, 0);
      assert.equal(d.opens.length, 0);
      assert.doesNotMatch(p.data.message, /已导出/);
    });

    for (const format of ["pdf", "excel"]) {
      test(`${filename}: ${change} during ${format} writing prevents opening`, async t => {
        const d = device(t, true), { c, p } = setup();
        const task = p.exportAll(format);
        await Promise.race([d.writing.promise, task.then(() => assert.fail("export never reached writing"))]);
        invalidate(p, c, change); d.writes[0].success({}); await task;
        assert.equal(d.opens.length, 0);
        assert.doesNotMatch(p.data.message, /已导出/);
      });
    }
  }

  for (const format of ["pdf", "excel"]) {
    test(`${filename}: current ${format} export still generates and opens all rows`, async t => {
      const d = device(t), { p } = setup();
      await p.exportAll(format);
      assert.equal(p.data.error, false, p.data.message);
      assert.match(p.data.message, /已导出 2/);
      assert.equal(d.opens.length, 1);
      assert.equal(Buffer.from(d.writes[0].data).subarray(0, 2).toString(), format === "pdf" ? "%P" : "PK");
      assert.equal(p.data.exporting, false);
    });
  }
}
