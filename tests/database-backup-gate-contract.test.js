"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "scripts", "cloudbase-pg-change.js"), "utf8");
const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
const context = fs.readFileSync(path.join(root, "PROJECT_CONTEXT.md"), "utf8");

test("production database writes are gated by a verified snapshot", () => {
  assert.match(source, /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ/);
  assert.match(source, /__lsg_backup_manifest/);
  assert.match(source, /row_count_matches/);
  assert.match(source, /数据库备份失败，已拒绝后续改动/);
  assert.match(source, /if \(!args\.backupOnly && !args\.apply\)/);
  assert.match(source, /--verified-backup/);
  assert.ok(source.indexOf("runCloudbaseSql(args.env, backupSql") < source.indexOf("runCloudbaseSql(args.env, changeSql)"));
});

test("project rules require backup before every production database mutation", () => {
  assert.match(agents, /every production database write/);
  assert.match(agents, /If backup creation or verification fails, stop/);
  assert.match(context, /生产数据库备份硬规则/);
  assert.match(context, /只读预览.*完整备份.*备份校验.*执行改动.*只读复核/s);
});
