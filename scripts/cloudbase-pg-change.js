#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = { apply: false, backupOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      parsed.apply = true;
      continue;
    }
    if (argument === "--backup-only") {
      parsed.backupOnly = true;
      continue;
    }
    if (["--env", "--sql", "--label", "--verified-backup"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${argument} 缺少参数`);
      parsed[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    fail(`不支持的参数：${argument}`);
  }
  return parsed;
}

function safeLabel(value) {
  const normalized = String(value || "database_change")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  return normalized || "database_change";
}

function timestampForIdentifier(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").replace("T", "_").toLowerCase();
}

function runCloudbaseSql(environmentId, sql) {
  const result = spawnSync(
    "npx",
    [
      "--yes",
      "--package",
      "@cloudbase/cli",
      "cloudbase",
      "db",
      "execute",
      "-e",
      environmentId,
      "--sql",
      sql,
      "--json"
    ],
    {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `CloudBase CLI 退出码 ${result.status}`);
  }

  const raw = result.stdout.trim();
  const jsonStart = raw.indexOf("{");
  if (jsonStart < 0) throw new Error("CloudBase CLI 未返回 JSON");
  const response = JSON.parse(raw.slice(jsonStart));
  if (!response.data) {
    throw new Error("CloudBase CLI 返回结构不完整");
  }
  if (!Array.isArray(response.data.Rows)) response.data.Rows = [];
  return response;
}

function rowsFrom(response) {
  return response.data.Rows.map((row) => JSON.parse(row));
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function backupSql(schemaName, environmentId, label) {
  const schema = quoteIdentifier(schemaName);
  const environmentLiteral = String(environmentId).replace(/'/g, "''");
  const labelLiteral = String(label).replace(/'/g, "''");
  return `
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;

CREATE SCHEMA ${schema};
REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;

CREATE TABLE ${schema}.__lsg_backup_metadata (
  backup_schema text PRIMARY KEY,
  environment_id text NOT NULL,
  change_label text NOT NULL,
  captured_at timestamptz NOT NULL,
  source_schema text NOT NULL
);

INSERT INTO ${schema}.__lsg_backup_metadata
  (backup_schema, environment_id, change_label, captured_at, source_schema)
VALUES
  ('${schemaName}', '${environmentLiteral}', '${labelLiteral}', clock_timestamp(), 'public');

CREATE TABLE ${schema}.__lsg_backup_manifest (
  table_name text PRIMARY KEY,
  source_rows bigint NOT NULL,
  backup_rows bigint NOT NULL,
  row_count_matches boolean NOT NULL
);

DO $backup$
DECLARE
  item record;
  source_count bigint;
  backup_count bigint;
BEGIN
  FOR item IN
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  LOOP
    EXECUTE format('LOCK TABLE public.%I IN ACCESS SHARE MODE', item.table_name);
    EXECUTE format('SELECT count(*) FROM public.%I', item.table_name) INTO source_count;
    EXECUTE format('CREATE TABLE ${schema}.%I AS TABLE public.%I', item.table_name, item.table_name);
    EXECUTE format('SELECT count(*) FROM ${schema}.%I', item.table_name) INTO backup_count;
    INSERT INTO ${schema}.__lsg_backup_manifest
      (table_name, source_rows, backup_rows, row_count_matches)
    VALUES
      (item.table_name, source_count, backup_count, source_count = backup_count);
  END LOOP;
END
$backup$;

CREATE TABLE ${schema}.__lsg_sequence_values AS
SELECT
  schemaname,
  sequencename,
  sequenceowner,
  data_type,
  start_value,
  min_value,
  max_value,
  increment_by,
  cycle,
  cache_size,
  last_value
FROM pg_sequences
WHERE schemaname = 'public'
ORDER BY sequencename;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ${schema}.__lsg_backup_manifest
    WHERE NOT row_count_matches
  ) THEN
    RAISE EXCEPTION 'backup row-count verification failed';
  END IF;

  IF (SELECT count(*) FROM ${schema}.__lsg_backup_manifest) = 0 THEN
    RAISE EXCEPTION 'backup did not capture any public base tables';
  END IF;
END
$verify$;

COMMIT;
`;
}

function verificationSql(schemaName) {
  const schema = quoteIdentifier(schemaName);
  return `
SELECT
  metadata.backup_schema,
  metadata.environment_id,
  metadata.change_label,
  metadata.captured_at,
  count(manifest.table_name)::bigint AS table_count,
  coalesce(sum(manifest.source_rows), 0)::bigint AS source_rows,
  coalesce(sum(manifest.backup_rows), 0)::bigint AS backup_rows,
  count(*) FILTER (WHERE NOT manifest.row_count_matches)::bigint AS mismatched_tables
FROM ${schema}.__lsg_backup_metadata AS metadata
JOIN ${schema}.__lsg_backup_manifest AS manifest ON true
GROUP BY
  metadata.backup_schema,
  metadata.environment_id,
  metadata.change_label,
  metadata.captured_at;
`;
}

function writeReceipt(receipt) {
  const receiptDirectory = path.resolve(__dirname, "..", ".codex-private", "database-backups");
  fs.mkdirSync(receiptDirectory, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(receiptDirectory, `${receipt.backupSchema}.json`);
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receiptPath;
}

const args = parseArgs(process.argv.slice(2));
if (!args.env) fail("必须提供 --env");
if (!args.label) fail("必须提供 --label");
if (args.backupOnly && args.sql) fail("--backup-only 不能与 --sql 同时使用");
if (!args.backupOnly && !args.sql) fail("必须提供 --sql，或明确使用 --backup-only");
if (!args.backupOnly && !args.apply) fail("执行数据库写入必须明确提供 --apply");

const startedAt = new Date();
const label = safeLabel(args.label);
const requestedBackup = args["verified-backup"];
if (requestedBackup && !/^backup_lsg_[a-z0-9_]+$/.test(requestedBackup)) {
  fail("--verified-backup 不是合法的备份 schema 名称");
}
const backupSchema = requestedBackup
  || `backup_lsg_${timestampForIdentifier(startedAt)}_${label}`.slice(0, 63);

let backupVerification;
try {
  if (!requestedBackup) runCloudbaseSql(args.env, backupSql(backupSchema, args.env, label));
  const verificationResponse = runCloudbaseSql(args.env, verificationSql(backupSchema));
  const [verified] = rowsFrom(verificationResponse);
  if (!verified
      || String(verified[0]) !== backupSchema
      || String(verified[1]) !== args.env
      || String(verified[7]) !== "0"
      || String(verified[4]) === "0"
      || String(verified[5]) !== String(verified[6])) {
    throw new Error("备份校验未通过");
  }
  backupVerification = {
    tableCount: Number(verified[4]),
    sourceRows: Number(verified[5]),
    backupRows: Number(verified[6]),
    mismatchedTables: Number(verified[7])
  };
} catch (error) {
  fail(`数据库备份失败，已拒绝后续改动：${error.message}`);
}

const receipt = {
  environmentId: args.env,
  changeLabel: label,
  backupSchema,
  startedAt: startedAt.toISOString(),
  verification: backupVerification,
  changeApplied: false
};
const receiptPath = writeReceipt(receipt);
console.log(`备份已验证：${backupSchema}（${backupVerification.tableCount} 张表，${backupVerification.sourceRows} 行）`);

if (args.backupOnly) {
  console.log(`备份回执：${receiptPath}`);
  process.exit(0);
}

const sqlPath = path.resolve(args.sql);
if (!fs.existsSync(sqlPath) || !fs.statSync(sqlPath).isFile()) fail(`SQL 文件不存在：${sqlPath}`);
const changeSql = fs.readFileSync(sqlPath, "utf8").trim();
if (!changeSql) fail(`SQL 文件为空：${sqlPath}`);

try {
  runCloudbaseSql(args.env, changeSql);
} catch (error) {
  fail(`备份已保留，但数据库改动失败：${error.message}`);
}

receipt.changeApplied = true;
receipt.completedAt = new Date().toISOString();
receipt.sqlFile = path.relative(path.resolve(__dirname, ".."), sqlPath);
writeReceipt(receipt);
console.log(`数据库改动已执行；对应备份：${backupSchema}`);
console.log(`备份回执：${receiptPath}`);
