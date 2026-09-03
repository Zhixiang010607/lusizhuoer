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
const photoReadReliability = read("cloudfunctions/verificationPhoto/read-reliability.js");
const photoVersion = `v${String(photoPackage.version).split(".")[0]}`;
assert.match(photoReadme, new RegExp(`当前版本：\`${photoVersion}\``),
  "verificationPhoto README must match its runtime version");
assert.match(photoReadme, new RegExp(`共享照片服务实现 \`${faceVersions[1]}\``),
  "verificationPhoto README must identify the embedded shared implementation version");
const photoAdapterVersion = /action === "health"[\s\S]*?version: "(v\d+)"/.exec(photoReadReliability)?.[1];
assert.equal(photoAdapterVersion, photoVersion,
  "verificationPhoto public health adapter must match its package major");
assert.match(faceReadme, new RegExp(`staffAccount ${staffVersion}`),
  "faceRecognition deployment matrix must name the current staffAccount runtime");
assert.match(photoReadme, new RegExp(`staffAccount(?:-| )${staffVersion}`),
  "verificationPhoto deployment matrix must name the current staffAccount runtime and ZIP");
assert.match(staffReadme, new RegExp(`faceRecognition ${faceVersions[2]}`),
  "staffAccount deployment matrix must name the current faceRecognition runtime");

const ratingSource = read("cloudfunctions/customerRating/index.js");
const ratingReadme = read("cloudfunctions/customerRating/README.md");
const ratingPackage = JSON.parse(read("cloudfunctions/customerRating/package.json"));
const ratingVersion = /const FUNCTION_VERSION = "(v\d+)"/.exec(ratingSource)?.[1];
assert.ok(ratingVersion, "customerRating must expose a runtime version");
assert.equal(`v${String(ratingPackage.version).split(".")[0]}`, ratingVersion,
  "customerRating package major must match its runtime version");
assert.match(ratingReadme, new RegExp(`当前版本：\`${ratingVersion}\``),
  "customerRating README must match its runtime version");
assert.match(ratingReadme, new RegExp(`customerRating-${ratingVersion}\\.zip`),
  "customerRating README must name its matching deployment ZIP");
for (const [name, source] of [
  ["faceRecognition", faceReadme], ["staffAccount", staffReadme], ["verificationPhoto", photoReadme]
]) {
  assert.match(source, new RegExp(`customerRating(?:-| )${ratingVersion}`),
    `${name} deployment matrix must name the current customerRating runtime`);
}

console.log("cloud function README version contract: PASS");
