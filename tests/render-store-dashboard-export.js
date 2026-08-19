"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createCanvas } = require("@napi-rs/canvas");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "tmp", "store-analytics-native-pages");
fs.mkdirSync(output, { recursive: true });
const context = {
  window: {},
  document: { createElement: (tag) => {
    if (tag !== "canvas") throw new Error(`Unsupported element: ${tag}`);
    return createCanvas(1, 1);
  } }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, "store-dashboard-export.js"), "utf8"), context, { filename: "store-dashboard-export.js" });

const metricValues = (index) => ({ recharge: 56 - index, verification: Math.max(0, 41 - index), experience: index % 5, refund: index % 3 });
const products = Array.from({ length: 7 }, (_, index) => ({ productId: String(index + 1), productName: `项目${index + 1}号护理`, status: index === 6 ? "ARCHIVED" : "ACTIVE", ...metricValues(index * 2) }));
const teachers = Array.from({ length: 27 }, (_, index) => ({ id: String(index + 1), name: `老师${String(index + 1).padStart(2, "0")}`, phone: `1380000${String(index).padStart(4, "0")}`, value: 0 }));
const dimensions = {};
for (const metric of ["recharge", "verification", "experience", "refund"]) {
  dimensions[metric] = {
    stores: [{ id: "7", name: "悉尼中心门店", phone: "0298765432", value: products.reduce((sum, item) => sum + item[metric], 0) }],
    teachers: teachers.map((teacher, index) => ({ ...teacher, value: Math.max(0, 50 - index * 2) })),
    products: products.map((product) => ({ id: product.productId, name: product.productName, phone: "", value: product[metric] }))
  };
}
const data = {
  range: { startDate: "2026-08-01", endDate: "2026-08-19" },
  store: { storeId: "7", storeName: "悉尼中心门店", phone: "0298765432" },
  products,
  totals: Object.fromEntries(["recharge", "verification", "experience", "refund"].map((metric) => [metric, products.reduce((sum, item) => sum + item[metric], 0)])),
  dimensions
};
const pages = context.window.StoreDashboardExport.renderReportPages({ data });
pages.forEach((canvas, index) => fs.writeFileSync(path.join(output, `page-${String(index + 1).padStart(2, "0")}.png`), canvas.toBuffer("image/png")));
process.stdout.write(JSON.stringify({ pages: pages.length, output }));
