'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '../miniprogram-app/miniprogram/components/project-summary');
function fixture() {
  let definition; const callbacks = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), { Component(value) { definition = value; }, wx: { nextTick(callback) { callback(); } } });
  const component = { ...definition.methods, data: { rows: [{productId:'1'}], totals: {}, totalsReady: true, loading: false, error: '', tableHeight: 0 }, _attached: true, setData(value) { Object.assign(this.data, value); }, createSelectorQuery() { const q={select(){return q;},boundingClientRect(callback){callbacks.push(callback);return q;},exec(){}};return q;} };
  return {component,callbacks,definition};
}
test('summary viewport follows actual wrapped table height and ignores older measurements', () => {
  const {component,callbacks}=fixture();
  component.measureTable();
  component.data.rows.push({productId:'2'});component.measureTable();
  callbacks[1]({height:247.4});callbacks[0]({height:110});
  assert.equal(component.data.tableHeight,248);
});
test('summary loading/error and detached states cannot retain a stale table height', () => {
  const {component,callbacks,definition}=fixture();
  component.measureTable();component.data.error='read failed';component.measureTable();callbacks[0]({height:900});
  assert.equal(component.data.tableHeight,0);
  component.data.error='';component.measureTable();definition.lifetimes.detached.call(component);callbacks[1]({height:800});
  assert.equal(component.data.tableHeight,0);
});
