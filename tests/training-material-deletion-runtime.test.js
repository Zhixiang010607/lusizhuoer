const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(`${__dirname}/../cloudfunctions/staffAccount/index.js`, "utf8");
function harness(options = {}) {
  const events = [];
  let row = options.absent ? null : { id: "1", file_reference: "pg://training-materials/training-materials/2026/fixture.pdf", material_status: "PUBLISHED" };
  const context = {
    fail: (message, code) => { throw Object.assign(new Error(message), { code }); },
    requireTrainingMaterialSchema: async () => {},
    numericId: (id) => { if (!/^\d+$/.test(String(id))) throw new Error("bad id"); return String(id); },
    databaseBoolean: x => x === true, sqlText: x => `'${x}'`,
    parseTrainingMaterialReference: x => ({ reference: x }), trainingMaterialStorageSettings: () => ({}),
    validateTrainingMaterialReference: () => { if (options.invalidReference) throw new Error("invalid bucket"); },
    asDatabaseError: e => { throw e; },
    deleteTrainingMaterialObject: async () => { events.push("object"); return !options.storageFailure; },
    executeSql: async sql => {
      if (sql.includes("to_regprocedure")) return [{ ready: !options.missingMigration }];
      if (sql.includes("UPDATE public.training_materials")) { events.push("stop-reading"); row.material_status = "ARCHIVED"; return []; }
      if (sql.includes("finalize_training_material_deletion")) { events.push("row-delete"); if (!options.rowFailure) row = null; return []; }
      events.push("readback"); return row ? [{ ...row }] : [];
    }
  };
  const start = source.indexOf("async function setTrainingMaterialStatus(");
  const end = source.indexOf("\nfunction validatedTrainingMaterialSignedUrl", start);
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  return { events, row: () => row, run: (input = {}) => context.setTrainingMaterialStatus({ materialId: "1", status: "ARCHIVED", confirmDeletion: true, ...input }) };
}
test("empty UPDATE RETURNING is resolved by exact readback, object removed before metadata", async () => {
  const h = harness(); const result = await h.run();
  assert.equal(result.deleted, true); assert.equal(result.id, "1"); assert.equal(h.row(), null);
  assert.ok(h.events.indexOf("stop-reading") < h.events.indexOf("object"));
  assert.ok(h.events.indexOf("object") < h.events.indexOf("row-delete"));
  assert.equal(h.events.at(-1), "readback");
});
test("unconfirmed requests, missing migration and invalid references never delete PDF", async () => {
  for (const [options, input] of [[{}, { confirmDeletion: false }], [{ missingMigration: true }, {}], [{ invalidReference: true }, {}]]) {
    const h = harness(options); await assert.rejects(h.run(input));
    assert.ok(!h.events.includes("object")); assert.equal(h.row().material_status, "PUBLISHED");
  }
});
test("partial failure preserves stopped-reading metadata, retry completes without recreating records", async () => {
  for (const option of ["storageFailure", "rowFailure"]) {
    const options = { [option]: true }; const h = harness(options);
    await assert.rejects(h.run(), { code: "TRAINING_MATERIAL_DELETE_PENDING" });
    assert.equal(h.row().material_status, "ARCHIVED");
    if (option === "storageFailure") assert.ok(!h.events.includes("row-delete"));
    options[option] = false; assert.equal((await h.run()).deleted, true);
    assert.equal(h.row(), null);
  }
});
test("lost acknowledgement or already-removed row succeeds idempotently without a second object deletion", async () => {
  const h = harness({ absent: true }); assert.equal((await h.run()).alreadyDeleted, true);
  assert.ok(!h.events.includes("object")); assert.ok(!h.events.includes("row-delete"));
});
test("migration is exact, client ACL closed, upload resurrection guarded and no business table touched", () => {
  const sql = fs.readFileSync(`${__dirname}/../database/migrations/087_training_material_deletion.sql`, "utf8");
  assert.equal(sql, fs.readFileSync(`${__dirname}/../database/cloudbase-console/087-01-training-material-deletion.sql`, "utf8"));
  assert.match(sql, /WHERE id = p_id AND file_reference = p_reference AND material_status = 'ARCHIVED'/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /guard_deleted_training_upload BEFORE INSERT/);
  assert.match(sql, /REVOKE DELETE ON TABLE public\.training_materials FROM service_role/);
  assert.doesNotMatch(sql, /verification_records|customer_product_balances|CASCADE|TRUNCATE/);
});
