const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(`${__dirname}/../cloudfunctions/staffAccount/index.js`, "utf8");

function harness(options = {}) {
  const calls = [];
  const body = Buffer.from(options.magic || "%PDF-1.7");
  const response = { status: options.status || 206, headers: {
    "content-range": options.range || "bytes 0-7/291840", "content-length": "8",
    "content-type": options.type || "application/pdf"
  }, body };
  const sandbox = {
    Buffer,
    fail: (message, code) => { throw Object.assign(new Error(message), { code }); },
    parseTrainingMaterialReference: () => ({ bucketId: "training-materials", objectName: "training-materials/2026/fixture.pdf" }),
    trainingMaterialStorageSettings: () => ({ accessToken: "fixture", envId: "test" }),
    validateTrainingMaterialReference: () => {},
    manager: () => ({ storage: { downloadAuthenticatedObject: async (args) => {
      calls.push(args);
      if (options.error) throw options.error;
      return response;
    } } })
  };
  const start = source.indexOf("async function productLogoResponseBuffer(");
  const end = source.indexOf("\nfunction productLogoSignedToken(", start);
  const inspectStart = source.indexOf("async function inspectTrainingMaterial(");
  const inspectEnd = source.indexOf("\nfunction trainingMaterialPayload(", inspectStart);
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end) + "\n" + source.slice(inspectStart, inspectEnd), sandbox);
  return { sandbox, calls };
}

test("PDF publication verifies size, type and magic with just one eight-byte storage request", async () => {
  const h = harness();
  const result = await h.sandbox.inspectTrainingMaterial("fixture", { bytes: 291840 });
  assert.equal(result.bytes, 291840);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].range, "bytes=0-7");
});

test("single range validation still rejects wrong total size, type, magic and non-range responses", async () => {
  for (const [options, code] of [
    [{ range: "bytes 0-7/291839" }, "TRAINING_MATERIAL_SIZE_MISMATCH"],
    [{ type: "image/jpeg" }, "TRAINING_MATERIAL_TYPE_INVALID"],
    [{ magic: "not-PDF!" }, "TRAINING_MATERIAL_FORMAT_INVALID"],
    [{ status: 200 }, "HTTP_200"]
  ]) await assert.rejects(harness(options).sandbox.inspectTrainingMaterial("fixture", { bytes: 291840 }), { code });
});

test("missing object is incomplete but transient range failure stays recoverable without claiming a bad PDF", async () => {
  await assert.rejects(harness({ error: { code: "HTTP_404" } }).sandbox.inspectTrainingMaterial("fixture", { bytes: 291840 }), { code: "TRAINING_MATERIAL_UPLOAD_INCOMPLETE" });
  await assert.rejects(harness({ error: { code: "ETIMEDOUT" } }).sandbox.inspectTrainingMaterial("fixture", { bytes: 291840 }), { code: "TRAINING_MATERIAL_READ_FAILED" });
  const confirmation = source.slice(source.indexOf("const verified = await inspectTrainingMaterial"), source.indexOf("let rows;", source.indexOf("const verified = await inspectTrainingMaterial")));
  assert.match(confirmation, /TRAINING_MATERIAL_SIZE_MISMATCH[\s\S]*includes\(error\?\.code\)/);
  assert.doesNotMatch(confirmation, /TRAINING_MATERIAL_READ_FAILED/);
});
