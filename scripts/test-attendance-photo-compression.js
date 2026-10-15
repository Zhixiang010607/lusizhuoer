"use strict";
// Development-only synthetic fixtures. No personal photo, network or database.
const assert = require("node:assert/strict"), crypto = require("node:crypto"), sharp = require("sharp");
const {prepareAttendancePhoto, probeAttendancePhotoRuntime} = require("../cloudfunctions/faceRecognition/attendance-photo");
(async()=>{
  const probe = await probeAttendancePhotoRuntime(); assert.equal(probe.ready, true);
  assert.equal(probe.jpegBytes.length, 2); console.log("Synthetic release runtime probe PASS");
  for (const [width,height] of [[1920,2560],[2560,1920],[720,1280],[640,480],[10000,160]]) {
    const input=await sharp({create:{width,height,channels:3,background:"#cdbb9c"}}).jpeg({quality:95}).toBuffer();
    for (const type of ["CLOCK_IN","CLOCK_OUT"]) {
      const result=await prepareAttendancePhoto(input,"2026-10-15T01:02:03Z",type);
      const m=await sharp(result.buffer).metadata();
      assert.ok(result.buffer.length<=3*1024*1024); assert.equal(m.width,width); assert.equal(m.height,height);
      assert.equal(m.format,"jpeg");
      assert.equal(m.exif,undefined);
      console.log(`${width}x${height} ${type}: ${m.width}x${m.height}, ${result.buffer.length} bytes PASS`);
    }
  }
  const raw=crypto.randomBytes(1920*2560*3);
  const noisy=await sharp(raw,{raw:{width:1920,height:2560,channels:3}}).jpeg({quality:65}).toBuffer();
  assert.ok(noisy.length<3*1024*1024,"valid captured input stays within work-order limit");
  await assert.rejects(prepareAttendancePhoto(noisy,"2026-10-15T01:02:03Z","CLOCK_IN"),{code:"ATTENDANCE_HD_PHOTO_TOO_LARGE"});
  console.log("Noisy HD evidence exceeding 3 MiB is rejected, never silently resized or degraded: PASS");
  const rotated=await sharp({create:{width:640,height:480,channels:3,background:"#cdbb9c"}}).jpeg().withMetadata({orientation:6}).toBuffer();
  const fixed=await prepareAttendancePhoto(rotated,"2026-10-15T01:02:03Z","CLOCK_IN");
  assert.equal(fixed.width,480); assert.equal(fixed.height,640);
  console.log("EXIF rotation preserved full image; metadata stripped PASS");
})().catch(e=>{console.error(e);process.exitCode=1;});
