"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const faceSource = read("cloudfunctions/faceRecognition/index.js");
const faceReadme = read("cloudfunctions/faceRecognition/README.md");
const faceVersions = /PHOTO_ONLY_FUNCTION \? "(v\d+)" : "(v\d+)"/.exec(faceSource);
assert.ok(faceVersions, "faceRecognition must expose photo-only and face runtime versions");
assert.match(faceReadme, new RegExp(`当前版本：\`${faceVersions[2]}\``),
  "faceRecognition README must match its runtime version");

const staffSource = read("cloudfunctions/staffAccount/index.js");
const staffReadme = read("cloudfunctions/staffAccount/README.md");
const staffVersion = /const FUNCTION_VERSION = "(v\d+)"/.exec(staffSource)?.[1];
assert.ok(staffVersion, "staffAccount must expose a runtime version");
assert.match(staffReadme, new RegExp(`当前版本：\`${staffVersion}\``),
  "staffAccount README must match its runtime version");

const teacherSource = read("cloudfunctions/teacherCreate/index.js");
const teacherReadme = read("cloudfunctions/teacherCreate/README.md");
const teacherVersion = /const FUNCTION_VERSION = "teacher-create-(v\d+)"/.exec(teacherSource)?.[1];
assert.ok(teacherVersion, "teacherCreate must expose a runtime version");
assert.match(teacherReadme, new RegExp(`^# teacherCreate ${teacherVersion}$`, "m"),
  "teacherCreate README title must match its runtime version");

const photoPackage = JSON.parse(read("cloudfunctions/verificationPhoto/package.json"));
const photoReadme = read("cloudfunctions/verificationPhoto/README.md");
const photoVersion = `v${String(photoPackage.version).split(".")[0]}`;
assert.equal(photoVersion, faceVersions[1],
  "verificationPhoto package major must match the shared photo-only runtime version");
assert.match(photoReadme, new RegExp(`当前版本：\`${photoVersion}\``),
  "verificationPhoto README must match its runtime version");

console.log("cloud function README version contract: PASS");
