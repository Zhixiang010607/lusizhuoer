"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), test = require("node:test"), vm = require("node:vm");
const dir = path.resolve(__dirname, "../miniprogram-app/miniprogram/components/store-search");
function component(stores, props = {}) {
  let definition; const events = [];
  vm.runInNewContext(fs.readFileSync(path.join(dir, "index.js"), "utf8"), {
    Component(value) { definition = value; }, wx: { getWindowInfo: () => ({ windowWidth: 390 }) }
  });
  const c = { ...definition.methods, data: { ...definition.data, stores, selectedId: "", loading: false, disabled: false, ...props },
    setData(value) { Object.assign(this.data, value); }, triggerEvent(name, detail) { events.push({ name, detail }); } };
  definition.lifetimes.attached.call(c);
  return { c, events };
}
const stores = [{ id: "a", name: "广州天河店" }, { id: "b", name: "深圳店" }, { id: "c", name: "广州海珠店" }];
test("fuzzy results retain original store indices; typing never selects a store", () => {
  const { c, events } = component(stores);
  c.input({ detail: { value: " 广州 " } });
  assert.deepEqual(Array.from(c.data.matches, row => row.value), [1, 3]);
  assert.equal(events.length, 0);
  c.choose({ currentTarget: { dataset: { value: 3 } } });
  assert.equal(events[0].detail.value, 3); assert.equal(c.data.keyword, "广州海珠店"); assert.equal(c.data.expanded, false);
});
test("editing a selection emits clear before any new choice; no match cannot choose", () => {
  const { c, events } = component(stores, { selectedId: "a" });
  assert.equal(c.data.keyword, "广州天河店");
  c.input({ detail: { value: "没有这个门店" } });
  assert.equal(events[0].detail.value, 0); assert.equal(c.data.matches.length, 0);
  c.choose({ currentTarget: { dataset: { value: 1 } } }); assert.equal(events.length, 1);
  c.data.selectedId = ""; c.sync(); assert.equal(c.data.keyword, "没有这个门店"); assert.equal(c.data.selectedName, "");
});
test("large result set can reach every match and replacing source removes stale choices", () => {
  const all = Array.from({ length: 123 }, (_, i) => ({ id: String(i + 1), name: `广州门店${i + 1}` }));
  const { c, events } = component(all); c.focus();
  assert.equal(c.data.matchCount, 123); assert.equal(c.data.matches.length, 50);
  c.more(); c.more(); assert.equal(c.data.matches.length, 123);
  c.choose({ currentTarget: { dataset: { value: 123 } } }); assert.equal(events[0].detail.value, 123);
  c.data.stores = []; c.sync(); c.choose({ currentTarget: { dataset: { value: 123 } } }); assert.equal(events.length, 1);
});
test("busy or loading freezes search, clearing and selection; resize tracks tablet row height", () => {
  for (const flag of ["disabled", "loading"]) {
    const { c, events } = component(stores); c.focus(); c.data[flag] = true; c.sync();
    c.input({ detail: { value: "深圳" } }); c.clear(); c.toggle(); c.focus(); c.more();
    c.choose({ currentTarget: { dataset: { value: 2 } } });
    assert.equal(events.length, 0); assert.equal(c.data.expanded, false); assert.equal(c.data.keyword, "");
    c.resize({ size: { windowWidth: 834 } }); assert.equal(c.data.tablet, true);
    c.resize({ size: { windowWidth: 390 } }); assert.equal(c.data.tablet, false);
  }
});
