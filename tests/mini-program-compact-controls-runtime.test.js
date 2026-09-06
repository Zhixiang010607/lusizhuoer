"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mini = path.resolve(__dirname, '../miniprogram-app/miniprogram');
function load(name) {
  const dir = path.join(mini, 'pages', name);
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(dir, 'index.js'), 'utf8'), {
    Page(value) { definition = value; }, wx: {},
    require(id) { return /\/api$|\/session$/.test(id) ? {} : require(path.resolve(dir, id)); }
  });
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) };
  page.setData = (patch, callback) => { Object.assign(page.data, patch); if (callback) callback(); };
  return page;
}
for (const [name, role] of [['home', 'teacher'], ['home', 'store'], ['store-detail', 'hq']]) {
  test(`${role} compact period picker preserves every date range and custom apply`, () => {
    const page = load(name);
    page.data.session = { role };
    let loads = 0;
    for (const fn of ['loadTeacherHome', 'loadStoreHome', 'reloadAnalytics']) page[fn] = () => { loads++; };
    for (const [index, expected] of ['QUARTER', 'YEAR', 'ALL', 'CUSTOM'].entries()) {
      const before = loads;
      page.chooseMoreRange({ detail: { value: String(index) } });
      assert.equal(page.data.rangePreset, expected);
      assert.equal(page.data.rangeMoreIndex, index);
      assert.equal(page.data.customRangeVisible, expected === 'CUSTOM');
      assert.equal(loads - before, expected === 'CUSTOM' ? 0 : 1);
      if (name === 'home' && expected === 'ALL') {
        assert.equal(page.data.rangeStart, '');
        assert.equal(page.data.rangeEnd, '');
      }
    }
    page.data.rangeStart = '2026-09-01'; page.data.rangeEnd = '2026-09-06';
    const before = loads; page.applyCustomRange(); assert.equal(loads, before + 1);
    for (const value of ['TODAY', 'WEEK', 'MONTH']) {
      page.chooseRange({ currentTarget: { dataset: name === 'home' ? { preset: value } : { value } } });
      assert.equal(page.data.rangePreset, value);
      assert.equal(page.data.rangeMoreLabel, '更多');
      assert.equal(page.data.customRangeVisible, false);
    }
    const final = loads;
    page.chooseMoreRange({ detail: { value: '99' } });
    page.chooseMoreRange({ detail: { value: '-1' } });
    assert.equal(loads, final);
  });
}
for (const name of ['inactive-customers', 'low-balance-customers', 'rating-analysis']) {
  test(`${name} rule disclosure preserves the query snapshot and pagination`, () => {
    const page = load(name);
    page.data.total = 26; page.data.zeroPage = 2; page.data.page = 2;
    const before = JSON.stringify(page.data);
    page.toggleRules(); assert.equal(page.data.rulesExpanded, true);
    page.toggleRules(); assert.equal(JSON.stringify(page.data), before);
  });
}
