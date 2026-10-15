"use strict";
// Development-only synthetic fixtures. No personal photo, network or database.
const assert = require("node:assert/strict"), crypto = require("node:crypto"), sharp = require("sharp");
const {prepareAttendancePhoto, probeAttendancePhotoRuntime} = require("../cloudfunctions/faceRecognition/attendance-photo");
(async()=>{
  const probe = await probeAttendancePhotoRuntime(); assert.equal(probe.ready, true);
  assert.equal(probe.jpegBytes.length, 2); console.log("Synthetic release runtime probe PASS");
  for (const [width,height] of [[1920,2560],[2560,1920],[640,480]]) {
    const raw=crypto.randomBytes(width*height*3);
    const input=await sharp(raw,{raw:{width,height,channels:3}}).jpeg({quality:95}).toBuffer();
    for (const type of ["CLOCK_IN","CLOCK_OUT"]) {
      const result=await prepareAttendancePhoto(input,"2026-10-15T01:02:03Z",type);
      const m=await sharp(result.buffer).metadata();
      assert.ok(result.buffer.length<=512*1024); assert.ok(Math.max(m.width,m.height)<=1280);
      assert.ok(Math.abs(m.width/m.height-width/height)<.005); assert.equal(m.format,"jpeg");
      assert.equal(m.exif,undefined);
      console.log(`${width}x${height} ${type}: ${m.width}x${m.height}, ${result.buffer.length} bytes PASS`);
    }
  }
  const rotated=await sharp({create:{width:640,height:480,channels:3,background:"#cdbb9c"}}).jpeg().withMetadata({orientation:6}).toBuffer();
  const fixed=await prepareAttendancePhoto(rotated,"2026-10-15T01:02:03Z","CLOCK_IN");
  assert.equal(fixed.width,480); assert.equal(fixed.height,640);
  console.log("EXIF rotation preserved full image; metadata stripped PASS");
})().catch(e=>{console.error(e);process.exitCode=1;});
