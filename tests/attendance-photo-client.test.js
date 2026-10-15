"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../miniprogram-app/miniprogram/components/attendance-photo/index.js"), "utf8");
function fixture(photoMetadata = {}, imageBytes = 10) {
  let definition, staffId = "7", bytesReads = 0, authorizations = 0;
  const files = new Map(), previews = [], calls = [];
  const image = Buffer.alloc(imageBytes,1);
  const api = async (_action, input) => {
    calls.push(input);
    if (input.authorizeOnly) authorizations++;
    if (input.readBytes) { bytesReads++; return {attendanceId: input.attendanceId, photo: {imageBase64:image.toString("base64"), bytes:image.length}}; }
    return {attendanceId:input.attendanceId, photo:{url:"https://example.invalid/private", bytes:image.length, ...photoMetadata}};
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
test("attendance preview follows verified photo dimensions without cropping", async()=>{
  for (const [metadata, expected] of [
    [{width:720,height:1280},177.7778], [{width:1280,height:720},56.25],
    [{width:960,height:1280},133.3333], [{width:2160,height:3840},177.7778], [{},133.3333],
    [{width:0,height:1280},133.3333], [{width:720,height:99999},133.3333],
    [{width:"NaN",height:1280},133.3333]
  ]) {
    const h=fixture(metadata); await h.c.load();
    assert.equal(h.c.data.aspectPercent,expected);
    h.c.properties.attendanceId=""; await h.c.load();
    assert.equal(h.c.data.aspectPercent,133.3333);
    assert.equal(h.c.data.url,"");
  }
});
test("HD original larger than old 512 KiB ceiling is readable up to the work-order limit", async()=>{
  const h=fixture({},3*1024*1024); await h.c.read();
  assert.equal(h.previews.length,1); assert.equal(h.c.data.error,"");
  assert.equal([...h.files.values()][0].length,3*1024*1024);
  const excessive=fixture({},3*1024*1024+1); await excessive.c.read();
  assert.equal(excessive.previews.length,0); assert.notEqual(excessive.c.data.error,"");
});
test("photo layout reserves the full aspect ratio on phones and retains tablet split layout", ()=>{
  const root=path.join(__dirname,"../miniprogram-app/miniprogram");
  const markup=fs.readFileSync(path.join(root,"components/attendance-photo/index.wxml"),"utf8");
  const styles=fs.readFileSync(path.join(root,"components/attendance-photo/index.wxss"),"utf8");
  assert.match(markup,/padding-top: \{\{aspectPercent\}\}%/);
  assert.match(markup,/mode="aspectFit"/);
  assert.match(styles,/\.photo \{[^}]*width: 100%; height: 100%/);
  assert.doesNotMatch(styles,/height: (?:320rpx|200px)/);
  assert.match(styles,/@media \(min-width: 700px\)/);
  assert.match(styles,/\.fill \.photo-frame \{[^}]*padding-top: 0 !important/);
  assert.match(styles,/\.fill \.photo-button \{[^}]*height: 44px/);
  assert.match(markup,/reading \? 'busy' : ''/);
  assert.match(styles,/\.busy \.photo-label \{ color: #6c5b45/);
});
test("completed attendance hides diagnostics while pre-punch location confirmation keeps accuracy", ()=>{
  const pages=path.join(__dirname,"../miniprogram-app/miniprogram/pages");
  for (const route of ["attendance","attendance-tracking","teacher-detail","work-calendar"]) {
    const markup=fs.readFileSync(path.join(pages,route,"index.wxml"),"utf8");
    assert.doesNotMatch(markup,/faceScore|人脸分数/);
    if(route!=="attendance") assert.doesNotMatch(markup,/\.accuracy/);
    else {
      assert.doesNotMatch(markup,/selectedAttendance\.clock(?:In|Out)\.accuracy/);
      assert.match(markup,/定位精度/);
      assert.match(markup,/locationPreview\.accuracy/);
    }
  }
});
