#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function fail(message) {
  console.error(message);
  process.exit(1);
}

const argv = process.argv.slice(2);
const environmentIndex = argv.indexOf("--env");
const sqlIndex = argv.indexOf("--sql");
if (environmentIndex < 0 || sqlIndex < 0 || !argv[environmentIndex + 1] || !argv[sqlIndex + 1]) {
  fail("用法：node scripts/cloudbase-pg-readonly.js --env <环境 ID> --sql <SQL 文件>");
}

const environmentId = argv[environmentIndex + 1];
const sqlPath = path.resolve(argv[sqlIndex + 1]);
if (!fs.existsSync(sqlPath) || !fs.statSync(sqlPath).isFile()) fail(`SQL 文件不存在：${sqlPath}`);
const sql = fs.readFileSync(sqlPath, "utf8").trim();
const withoutComments = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const inspectedSql = withoutComments.replace(/'(?:''|[^'])*'/g, " ");
if (!/^(select|with|explain|show)\b/i.test(inspectedSql.trim())) fail("只读执行器只允许 SELECT、WITH、EXPLAIN 或 SHOW");
if (/\b(insert|update|delete|truncate|alter|create|drop|grant|revoke|merge|call|do|copy|vacuum|reindex|cluster|refresh)\b/i.test(inspectedSql)) {
  fail("SQL 文件包含写入或结构变更关键字，已拒绝执行");
}

const result = spawnSync(
  "npx",
  ["--yes", "--package", "@cloudbase/cli", "cloudbase", "db", "execute", "-e", environmentId, "--sql", sql, "--json"],
  {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  }
);
if (result.error) fail(result.error.message);
if (result.status !== 0) fail(result.stderr.trim() || result.stdout.trim() || `退出码 ${result.status}`);
process.stdout.write(result.stdout);
