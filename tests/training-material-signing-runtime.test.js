const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(`${__dirname}/../cloudfunctions/staffAccount/index.js`, "utf8");
function extract(name, next) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\n${next}`, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
const storage = { envId: "test-env", bucketId: "training-materials", accessToken: "test-secret" };
const reference = { bucketId: storage.bucketId, objectName: "training-materials/2026/test.pdf" };
const pathname = `/v1/storages/object/sign/${reference.bucketId}/${reference.objectName}`;
const query = "?token=fixture%2Btoken%2Fvalue&other=keep%20escaping";
const origin = "https://test-env.api.tcloudbasegateway.com";
function harness(response, status = "PUBLISHED") {
  const calls = [];
  const sandbox = {
    URL,
    requireTrainingMaterialSchema: async () => {}, numericId: (id) => id,
    executeSql: async () => [{ id: 1, title: "测试资料", material_status: status, file_reference: "test", file_bytes: 291840, published_at: "2026-10-12T00:00:00Z" }],
    trainingMaterialPayload: (row) => ({ id: String(row.id), bytes: row.file_bytes, status: row.material_status, publishedAt: row.published_at }),
    parseTrainingMaterialReference: () => reference,
    trainingMaterialStorageSettings: () => storage,
    validateTrainingMaterialReference: () => {},
    fail: (message, code) => { throw Object.assign(new Error(message), { code }); },
    manager: () => ({ storage: { signObject: async (args) => { calls.push(args); return response; } } })
  };
  sandbox.requireTrainingReader = (caller) => {
    if (!["hq", "teacher"].includes(caller.role) || (caller.role === "teacher" && caller.status !== "ACTIVE")) sandbox.fail("denied", "FORBIDDEN");
    return caller.role;
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extract("nestedString", "function signedStorageUrl("),
    extract("signedStorageUrl", "function safeResponseShape("),
    extract("validatedProductLogoSignedUrl", "async function signProductLogoUncached("),
    extract("validatedTrainingMaterialSignedUrl", "async function getTrainingMaterialAccess("),
    source.slice(source.indexOf("async function getTrainingMaterialAccess("), source.indexOf("\nasync function main("))
  ].join("\n"), sandbox);
  return { sandbox, calls };
}
test("SDK relative PDF signing response becomes exact trusted HTTPS URL without changing token bytes", async () => {
  const { sandbox, calls } = harness({ signedURL: pathname + query });
  const result = await sandbox.getTrainingMaterialAccess({ role: "hq" }, { materialId: 1 });
  assert.equal(result.url, origin + pathname + query);
  assert.equal(result.expiresIn, 300);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].objectName, reference.objectName);
  assert.equal(calls[0].expiresIn, 300);
});
test("cache authorization returns current publication metadata without any storage signer", async () => {
  const { sandbox, calls } = harness({});
  const result = await sandbox.getTrainingMaterialAccess({ role: "teacher", status: "ACTIVE" }, { materialId: 1, authorizeOnly: true });
  assert.equal(result.cacheAuthorized, true);
  assert.equal(result.material.bytes, 291840);
  assert.equal(result.url, undefined);
  assert.equal(calls.length, 0);
});
test("archive blocks cached and fresh reads for both headquarters and teachers", async () => {
  const { sandbox, calls } = harness({}, "ARCHIVED");
  for (const caller of [{ role: "hq" }, { role: "teacher", status: "ACTIVE" }]) {
    for (const authorizeOnly of [true, false]) await assert.rejects(sandbox.getTrainingMaterialAccess(caller, { materialId: 1, authorizeOnly }), { code: "NOT_FOUND" });
  }
  assert.equal(calls.length, 0);
});
test("full signed URL remains unchanged and active teacher uses the same private signer", async () => {
  const { sandbox } = harness({ signedURL: origin + pathname + query });
  const result = await sandbox.getTrainingMaterialAccess({ role: "teacher", status: "ACTIVE" }, { materialId: 1 });
  assert.equal(result.url, origin + pathname + query);
});
test("PDF signing fails closed for foreign hosts, wrong objects, absent tokens and malformed paths", () => {
  const { sandbox } = harness({});
  for (const value of [
    "//evil.example" + pathname + query, "http://test-env.api.tcloudbasegateway.com" + pathname + query,
    "https://evil.example" + pathname + query, pathname.replace("test.pdf", "other.pdf") + query,
    pathname.replace("training-materials/2026", "customer-photos/2026") + query,
    pathname, pathname + "?token=",
    "/v1/storages/object/sign/%ZZ" + query, "javascript:alert(1)",
    pathname.replace("test.pdf", "../test.pdf") + query
  ]) {
    assert.equal(sandbox.validatedTrainingMaterialSignedUrl({ signedURL: value }, storage, reference), "", value);
  }
});
test("store and archived teacher cannot reach the PDF storage signer", async () => {
  const { sandbox, calls } = harness({ signedURL: pathname + query });
  for (const caller of [{ role: "store" }, { role: "teacher", status: "ARCHIVED" }]) {
    await assert.rejects(sandbox.getTrainingMaterialAccess(caller, { materialId: 1 }), { code: "FORBIDDEN" });
  }
  assert.equal(calls.length, 0);
});
