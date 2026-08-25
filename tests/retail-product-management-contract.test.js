"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("migration 060 creates an isolated retail product master that cannot be deleted", () => {
  const migration = read("database/migrations/060_retail_products.sql");
  const consoleSql = read("database/cloudbase-console/060-01-retail-products.sql");
  const verify = read("database/cloudbase-console/060-readonly-verify.sql");
  for (const sql of [migration, consoleSql]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.retail_products/);
    assert.match(sql, /RETURN 'PDT' \|\| LPAD/);
    assert.match(sql, /product_name TEXT NOT NULL/);
    assert.match(sql, /product_status VARCHAR\(16\) NOT NULL DEFAULT 'ACTIVE'/);
    assert.match(sql, /uq_retail_products_normalized_name/);
    assert.match(sql, /uq_retail_products_idempotency_key/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.retail_product_status_history/);
    assert.match(sql, /trg_060_prevent_retail_product_delete/);
    assert.match(sql, /RETAIL_PRODUCT_DELETE_FORBIDDEN/);
    assert.doesNotMatch(sql, /DELETE FROM public\.retail_products/i);
    assert.match(sql, /BEGIN;[\s\S]*COMMIT;\s*$/);
  }
  assert.match(verify, /archive audit and delete guard triggers/);
  assert.match(verify, /CASE WHEN record_count = 2 THEN 'READY'/);
});

test("staffAccount v73 exposes HQ-only retail product list, create and archive APIs without delete", () => {
  const cloud = read("cloudfunctions/staffAccount/index.js");
  assert.match(cloud, /const FUNCTION_VERSION = "v73"/);
  for (const action of ["listRetailProducts", "createRetailProduct", "setRetailProductStatus"]) {
    assert.match(cloud, new RegExp(`action === "${action}"\\) \\{[\\s\\S]{0,180}requireHq\\(caller\\)`), `${action} must require headquarters`);
  }
  assert.match(cloud, /INSERT INTO public\.retail_products[\s\S]*product_name[\s\S]*idempotency_key/);
  assert.match(cloud, /UPDATE public\.retail_products[\s\S]*product_status/);
  assert.match(cloud, /产品状态写入后数据库回读不一致/);
  assert.doesNotMatch(cloud, /action === "deleteRetailProduct"/);
  assert.doesNotMatch(cloud, /DELETE FROM public\.retail_products/i);
});

test("web separates project templates from the simple product master", () => {
  const auth = read("auth-ui.js");
  const projectList = read("project-management.html");
  const projectCreate = read("project-create.html");
  const projectDetail = read("project-detail.html");
  const retailHtml = read("retail-product-management.html");
  const retailJs = read("retail-product-management.js");
  assert.match(auth, /\["project-management\.html", "项目管理"\], \["retail-product-management\.html", "产品管理"\]/);
  for (const label of ["全部项目", "点击项目进入单据模板设置", "新增项目"]) assert.match(projectList, new RegExp(label));
  for (const label of ["项目创建", "项目资料", "项目名称", "创建项目"]) assert.match(projectCreate, new RegExp(label));
  for (const label of ["项目单据模板", "返回项目管理", "共用项目 LOGO"]) assert.match(projectDetail, new RegExp(label));
  for (const label of ["产品管理", "新增产品", "产品名称", "产品编号", "封存产品", "重新激活"]) {
    assert.match(`${retailHtml}\n${retailJs}`, new RegExp(label));
  }
  assert.match(retailJs, /listRetailProducts/);
  assert.match(retailJs, /createRetailProduct/);
  assert.match(retailJs, /setRetailProductStatus/);
  assert.doesNotMatch(retailHtml, /产品类别|产品介绍|单据模板|LOGO/);
  assert.doesNotMatch(retailJs, /deleteRetailProduct/);
});

test("mini program exposes separate project and product entries and keeps product data minimal", () => {
  const app = JSON.parse(read("miniprogram-app/miniprogram/app.json"));
  const routes = [
    ...app.pages,
    ...(app.subPackages || []).flatMap((item) => item.pages.map((page) => `${item.root}/${page}`))
  ];
  const home = read("miniprogram-app/miniprogram/pages/home/index.wxml");
  const homeJs = read("miniprogram-app/miniprogram/pages/home/index.js");
  const page = read("miniprogram-app/miniprogram/pages/retail-product-management/index.wxml");
  const logic = read("miniprogram-app/miniprogram/pages/retail-product-management/index.js");
  assert.ok(routes.includes("pages/retail-product-management/index"));
  assert.match(home, /data-type="project"[^>]*>项目管理</);
  assert.match(home, /data-type="product"[^>]*>产品管理</);
  assert.match(homeJs, /type === "project"[\s\S]*pages\/product-management\/index/);
  assert.match(homeJs, /type === "product"[\s\S]*pages\/retail-product-management\/index/);
  for (const label of ["只填写产品名称", "产品名称", "产品编号", "只能封存或重新激活"]) assert.match(page, new RegExp(label));
  assert.doesNotMatch(page, /产品类别|产品介绍|单据模板|LOGO/);
  for (const action of ["listRetailProducts", "createRetailProduct", "setRetailProductStatus"]) assert.match(logic, new RegExp(action));
  assert.doesNotMatch(logic, /deleteRetailProduct/);
});
