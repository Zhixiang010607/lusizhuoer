const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(`${__dirname}/../cloudfunctions/staffAccount/index.js`, "utf8");

function harness(options = {}) {
  const calls = [], deleted = [];
  const input = { title: "纯测试", category: "", bytes: 8 * 1024 * 1024, originalName: "fixture.pdf" };
  const reference = "pg://training-materials/training-materials/2026/fixture.pdf";
  let row = options.existing || null, inserted = false;
  const sandbox = {
    requireTrainingMaterialSchema: async () => {}, trainingMaterialInput: () => input,
    parseTrainingMaterialReference: () => ({ reference }),
    sameTrainingMaterialRequest: (value) => value.file_reference === reference && value.title === input.title,
    inspectTrainingMaterial: async () => { calls.push("inspect"); return { reference: { reference } }; },
    trainingMaterialPayload: value => ({ id: String(value.id), status: value.material_status }),
    sqlText: value => `'${value}'`, numericId: value => value,
    fail: (message, code) => { throw Object.assign(new Error(message), { code }); },
    asDatabaseError: () => { throw Object.assign(new Error("数据库暂不可用"), { code: "DATABASE_ERROR" }); },
    deleteTrainingMaterialObject: async value => { deleted.push(value); },
    executeSql: async sql => {
      if (sql.includes("training_material_deleted_requests")) return options.retired ? [{ client_request_id: "retired" }] : [];
      if (sql.includes("INSERT INTO public.training_materials")) {
        calls.push("insert"); inserted = true;
        if (!options.noCommit) row = { id: "71", title: input.title, file_reference: reference, material_status: "PUBLISHED" };
        if (options.insertError) throw new Error("lost write acknowledgement");
        return options.emptyReturning || options.noCommit ? [] : [row];
      }
      calls.push("read");
      if (inserted && options.readError) throw new Error("read unavailable");
      return row ? [row] : [];
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf("async function confirmTrainingMaterialUpload("), source.indexOf("\nasync function discardTrainingMaterialUpload(")), sandbox);
  return { run: () => sandbox.confirmTrainingMaterialUpload({ profile: { staffId: "7", staffName: "纯测试" } }, { ...input, reference, clientRequestId: "test_publish_123456" }), calls, deleted };
}

test("publication reads the exact original request after an empty INSERT RETURNING", async () => {
  const h = harness({ emptyReturning: true });
  assert.deepEqual(JSON.parse(JSON.stringify(await h.run())), { id: "71", status: "PUBLISHED" });
  assert.deepEqual(h.calls, ["read", "inspect", "insert", "read"]);
  assert.equal(h.deleted.length, 0);
});

test("uncertain database publication never deletes the successfully uploaded PDF", async () => {
  for (const options of [{ noCommit: true, insertError: true }, { insertError: true, readError: true }, { noCommit: true, emptyReturning: true }]) {
    const h = harness(options);
    await assert.rejects(h.run(), { code: "TRAINING_MATERIAL_PUBLISH_PENDING" });
    assert.equal(h.deleted.length, 0);
    assert.equal(h.calls.filter(x => x === "insert").length, 1);
  }
});

test("lost INSERT acknowledgement recovers its original published row without another transfer", async () => {
  const h = harness({ insertError: true });
  assert.equal((await h.run()).id, "71");
  assert.equal(h.deleted.length, 0);
  assert.equal(h.calls.filter(x => x === "inspect").length, 1);
});

test("existing publication remains idempotent and retired requests cannot publish", async () => {
  const h = harness({ existing: { id: "71", title: "纯测试", file_reference: "pg://training-materials/training-materials/2026/fixture.pdf", material_status: "PUBLISHED" } });
  assert.equal((await h.run()).id, "71");
  assert.deepEqual(h.calls, ["read"]);
  await assert.rejects(harness({ retired: true }).run(), { code: "TRAINING_MATERIAL_DELETED" });
});
