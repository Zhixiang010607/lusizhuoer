const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(`${__dirname}/../miniprogram-app/miniprogram/pages/home/index.js`, "utf8");
function harness(role = "teacher") {
  const page = vm.runInNewContext(`({${source.slice(source.indexOf("  closeMenus(changes"), source.indexOf("  jumpToSection(event"))}})`);
  let callback;
  const selectors = [];
  const query = {
    select(value) { selectors.push(value); return this; },
    boundingClientRect() { return this; },
    exec(value) { callback = value; }
  };
  page.data = { session: { role }, learningMenuOpen: false };
  page.setData = (data) => Object.assign(page.data, data);
  page.createSelectorQuery = () => query;
  return { page, selectors, resolve: (rects) => callback(rects) };
}
test("learning uses its own measured trigger and stays within phone/tablet bounds", () => {
  for (const [width, left, bottom] of [[320, 172, 56], [390, 209, 56], [430, 230, 56], [768, 220, 64], [834, 220, 64], [1024, 220, 64], [1366, 343, 64]]) {
    const { page, selectors, resolve } = harness();
    page.toggleLearningMenu();
    resolve([{ left }, { width, bottom }]);
    assert.equal(page.data.learningMenuOpen, true);
    assert.deepEqual(selectors, ["#learning-menu-trigger", ".workspace-rail"]);
    const values = Object.fromEntries(page.data.learningPopoverStyle.split(";").filter(Boolean).map((part) => { const [key, value] = part.split(":"); return [key, parseFloat(value)]; }));
    assert.equal(values.left, left);
    assert.equal(values.top, bottom);
    assert.ok(values.left + values.width <= width - 12);
  }
});
test("a late learning measurement cannot reopen over another menu or after resize/hide", () => {
  for (const action of ["toggleBusinessMenu", "onResize", "onHide"]) {
    const { page, resolve } = harness();
    page.toggleLearningMenu();
    page[action]();
    resolve([{ left: 210 }, { width: 390, bottom: 56 }]);
    assert.equal(page.data.learningMenuOpen, false);
  }
});
test("learning closes on the second tap and missing geometry never opens a left-edge fallback", () => {
  const { page, resolve } = harness();
  page.toggleLearningMenu(); resolve([null, { width: 390, bottom: 56 }]);
  assert.equal(page.data.learningMenuOpen, false);
  page.toggleLearningMenu(); resolve([{ left: 210 }, { width: 390, bottom: 56 }]);
  page.toggleLearningMenu();
  assert.equal(page.data.learningMenuOpen, false);
});
test("store and HQ do not acquire the teacher learning dropdown", () => {
  for (const role of ["store", "hq"]) {
    const { page, selectors } = harness(role);
    page.toggleLearningMenu();
    assert.equal(selectors.length, 0);
    assert.equal(page.data.learningMenuOpen, false);
  }
});
