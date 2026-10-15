"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../miniprogram-app/miniprogram/components/attendance-photo/index.js"), "utf8");
function fixture() {
  let definition, staffId = "7", bytesReads = 0, authorizations = 0;
  const files = new Map(), previews = [], calls = [];
  const image = Buffer.from("test-photo");
  const api = async (_action, input) => {
    calls.push(input);
    if (input.authorizeOnly) authorizations++;
    if (input.readBytes) { bytesReads++; return {attendanceId: input.attendanceId, photo: {imageBase64:image.toString("base64"), bytes:image.length}}; }
    return {attendanceId:input.attendanceId, photo:{url:"https://example.invalid/private", bytes:image.length}};
  };
  const fileSystem = {
    writeFile(o) {files.set(o.filePath, Buffer.from(o.data, "base64")); o.success();},
    getFileInfo(o) {o.success({size:files.get(o.filePath).length});},
    statSync(p) {if (!files.has(p)) throw Error("absent"); return {size:files.get(p).length};},
    unlink(o) {files.delete(o.filePath);}
  };
  vm.runInNewContext(source, {Map, Date, Promise, Number, String, Error,
    getApp:()=>({globalData:{session:{staffId}}}),
    wx:{env:{USER_DATA_PATH:"/private-test"}, getFileSystemManager:()=>fileSystem, previewImage:(o)=>previews.push(o)},
    Component:(d)=>{definition=d;}, require:()=>({callFace:api})});
  const c = {properties:{attendanceId:"31"},data:{...definition.data},setData(v){Object.assign(this.data,v);}};
  Object.assign(c, definition.methods); c._alive=true; c._epoch=1;
  return {c, files, previews, calls, setAccount(v){staffId=v;}, get bytesReads(){return bytesReads;}, get authorizations(){return authorizations;}};
}
test("attendance cache reauthorizes every hit and re-downloads a truncated file", async()=>{
  const h=fixture(); await h.c.read(); await h.c.read();
  assert.equal(h.authorizations,2); assert.equal(h.bytesReads,1); assert.equal(h.previews.length,2);
  h.files.set([...h.files.keys()][0],Buffer.from("truncated"));
  await h.c.read(); assert.equal(h.bytesReads,2); assert.equal(h.previews.length,3);
});
test("switching account never reuses another staff cache or preview", async()=>{
  const h=fixture(); await h.c.read(); h.setAccount("8"); await h.c.read();
  assert.equal(h.bytesReads,2); assert.equal(h.authorizations,2);
  const pending=h.c.read(); h.setAccount("9"); await pending;
  assert.equal(h.previews.length,2);
});
test("new attendance identity resets a stale reading state", async()=>{
  const h=fixture(); h.c.data.reading=true; await h.c.load(); assert.equal(h.c.data.reading,false);
  assert.equal(h.c.data.url,"https://example.invalid/private");
});
