"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");
const read = (...parts) => fs.readFileSync(path.join(mini, ...parts), "utf8");

test("mini project management follows the dedicated web mobile list instead of the generic directory", () => {
  const home = read("pages", "home", "index.js");
  const listJs = read("pages", "product-management", "index.js");
  const listWxml = read("pages", "product-management", "index.wxml");
  const legacy = read("pages", "hq-directory", "index.js");

  assert.match(home, /type === "project"[\s\S]*pages\/product-management\/index/);
  assert.match(legacy, /options\.type === "project"[\s\S]*pages\/product-management\/index/);
  assert.match(listJs, /callStaff\("listProducts"\)/);
  assert.match(listWxml, /全部项目/);
  assert.match(listWxml, /点击项目进入单据模板设置/);
  assert.match(listWxml, /新增项目/);
  assert.match(listWxml, /模板已配置/);
  assert.match(listWxml, /模板待配置/);
  for (const retired of ["查询项目", "重置", "活跃项目", "封存项目"]) {
    assert.doesNotMatch(listWxml, new RegExp(retired), `dedicated project list must not render ${retired}`);
  }
});

test("mini project creation is a dedicated idempotent page and continues directly to template setup", () => {
  const js = read("pages", "product-create", "index.js");
  const wxml = read("pages", "product-create", "index.wxml");
  assert.match(js, /lusizhuoerMiniProductCreateV1/);
  assert.match(js, /callStaff\("createProduct"/);
  assert.match(js, /clientRequestId:\s*pendingRequestId\(\)/);
  assert.match(js, /product-detail\/index\?productRef=/);
  assert.match(js, /wx\.removeStorageSync\(PENDING_KEY\)/);
  for (const label of ["项目创建", "项目资料", "项目名称", "项目类别", "项目介绍（选填）", "返回项目管理", "创建项目"]) {
    assert.match(wxml, new RegExp(label));
  }
});

test("mini project template shares the authoritative web services and verifies every mutation", () => {
  const js = read("pages", "product-detail", "index.js");
  const wxml = read("pages", "product-detail", "index.wxml");

  for (const action of [
    "getProductReceiptTemplate", "beginProductLogoUpload", "uploadProductLogoByFunction", "confirmProductLogoUpload",
    "discardProductLogoUpload", "getProductReceiptLogoData", "saveProductReceiptTemplate", "removeProductReceiptLogo", "setProductStatus"
  ]) assert.match(js, new RegExp(`callStaff\\(\\"${action}\\"`), `product template is missing ${action}`);
  assert.match(js, /sizeType:\s*\["original"\]/, "logo selection must retain original bytes");
  assert.doesNotMatch(js, /compressImage/, "product logos must not be recompressed");
  assert.match(js, /const reread = await callStaff\("getProductReceiptTemplate"/);
  assert.match(js, /assertRoundTrip\(reread\.template/);
  assert.match(js, /template\.productStatus !== next/);
  assert.match(js, /jpegPdf\(/);
  assert.match(js, /saveImageToAlbum/);
  assert.match(js, /wx\.openDocument/);
  assert.match(js, /fileType:\s*"pdf"[\s\S]*showMenu:\s*true/);
  assert.doesNotMatch(js, /shareFileMessage/, "async PDF generation must open the native document viewer instead of losing the original TAP gesture");
  for (const label of ["项目单据模板", "模板内容", "共用项目 LOGO", "正常核销与体验核销共用", "充值与退费共用", "保存文字说明", "四种成品预览", "刷新预览", "下载样例"]) {
    assert.match(wxml, new RegExp(label), `product template UI is missing ${label}`);
  }
  for (const retired of ["logoMeta", "不压缩", "不裁切", "文件大小", "像素尺寸"]) assert.doesNotMatch(wxml, new RegExp(retired));
  assert.match(wxml, /class="preview-tab-row"/);
  for (const kind of ["verification-pdf", "verification-image", "recharge-pdf", "recharge-image"]) {
    assert.match(js, new RegExp(kind));
  }
});

test("mini product pages are registered without repeating the HQ home rail", () => {
  const app = JSON.parse(read("app.json"));
  const registeredPages = [
    ...app.pages,
    ...(app.subPackages || []).flatMap((subpackage) =>
      subpackage.pages.map((page) => `${subpackage.root}/${page}`))
  ];
  for (const route of ["pages/product-management/index", "pages/product-create/index", "pages/product-detail/index"]) {
    assert.ok(registeredPages.includes(route), `${route} is not registered`);
  }
  for (const page of ["product-management", "product-create", "product-detail"]) {
    const json = JSON.parse(read("pages", page, "index.json"));
    const wxml = read("pages", page, "index.wxml");
    assert.equal(json.usingComponents && json.usingComponents["hq-rail"], undefined);
    assert.doesNotMatch(wxml, /<hq-rail\b/);
  }
});
