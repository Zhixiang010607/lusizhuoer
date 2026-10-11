#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--verify-only") {
      result.verifyOnly = true;
      continue;
    }
    if (!["--env", "--backup-schema", "--keep-staff-ids"].includes(key)) fail(`不支持的参数：${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${key} 缺少参数`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function run(args) {
  const result = spawnSync("npx", ["--yes", "--package", "@cloudbase/cli", "cloudbase", ...args], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `退出码 ${result.status}`);
  return result.stdout.trim();
}

function parseJsonOutput(raw) {
  const index = raw.indexOf("{");
  if (index < 0) throw new Error("CLI 未返回 JSON");
  return JSON.parse(raw.slice(index));
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

const args = parseArgs(process.argv.slice(2));
if (!args.env || !args["backup-schema"] || !args["keep-staff-ids"]) {
  fail("必须提供 --env、--backup-schema 和 --keep-staff-ids");
}
if (!/^backup_lsg_[a-z0-9_]+$/.test(args["backup-schema"])) fail("备份 schema 名称不合法");
const keepIds = args["keep-staff-ids"].split(",").map((value) => Number(value.trim()));
if (!keepIds.length || keepIds.some((value) => !Number.isSafeInteger(value) || value <= 0)) fail("保留账号 ID 不合法");

const schema = quoteIdentifier(args["backup-schema"]);
const sql = `
SELECT id, auth_uid
FROM ${schema}.staff_accounts
WHERE auth_uid IS NOT NULL
  AND btrim(auth_uid) <> ''
ORDER BY id;
`;

let backedUpAccounts;
try {
  const raw = run(["db", "execute", "-e", args.env, "--sql", sql, "--json"]);
  const response = parseJsonOutput(raw);
  backedUpAccounts = response.data.Rows.map((row) => {
    const [id, uid] = JSON.parse(row);
    return { id: Number(id), uid: String(uid) };
  });
} catch (error) {
  fail(`无法读取备份中的待封禁认证身份：${error.message}`);
}

const blockedAccounts = backedUpAccounts.filter((account) => !keepIds.includes(account.id));
const retainedAccounts = backedUpAccounts.filter((account) => keepIds.includes(account.id));
if (retainedAccounts.length !== keepIds.length) fail("备份中的保留认证身份数量不匹配");

let blocked = 0;
if (!args.verifyOnly) {
  for (const account of blockedAccounts) {
    try {
      run(["user", "update", account.uid, "-e", args.env, "--status", "BLOCKED", "--json"]);
      blocked += 1;
    } catch (error) {
      fail(`认证身份封禁中止：已完成 ${blocked}/${blockedAccounts.length}；${error.message}`);
    }
  }
}

const allUids = backedUpAccounts.map((account) => account.uid);
let listedUsers;
try {
  const response = parseJsonOutput(run([
    "user", "list", "-e", args.env, "--uids", allUids.join(","), "--limit", String(allUids.length), "--json"
  ]));
  listedUsers = response.data;
} catch (error) {
  fail(`认证身份状态回读失败：${error.message}`);
}
if (!Array.isArray(listedUsers)) fail("认证身份状态回读结构不完整");
const byUid = new Map(listedUsers.map((user) => [
  String(user.uid ?? user.Uid),
  String(user.status ?? user.UserStatus)
]));
if (blockedAccounts.some((account) => byUid.get(account.uid) !== "BLOCKED")) {
  const diagnostic = listedUsers.map((user) => ({
    fields: Object.keys(user).sort(),
    status: user.status ?? user.UserStatus ?? null
  }));
  fail(`至少一个已清理账号的认证身份未处于 BLOCKED 状态；回读结构：${JSON.stringify(diagnostic)}`);
}
if (retainedAccounts.some((account) => byUid.get(account.uid) !== "ACTIVE")) {
  fail("至少一个保留总部账号的认证身份未处于 ACTIVE 状态");
}

console.log(`认证身份状态已验证：${blockedAccounts.length} 个 BLOCKED，${retainedAccounts.length} 个保留账号 ACTIVE。`);
