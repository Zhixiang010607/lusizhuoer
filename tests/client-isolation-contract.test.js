"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const miniRoot = path.join(root, "miniprogram-app", "miniprogram");
const nativeRoot = path.join(root, "native-app");

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "miniprogram_npm"].includes(entry.name)) return [];
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(fullPath) : [fullPath];
  });
}

test("Web, Mini Program, and future native App keep separate client roots", () => {
  assert.ok(fs.existsSync(path.join(nativeRoot, "README.md")), "future native App must have an explicit isolated root");

  const webRuntimeFiles = fs.readdirSync(root)
    .filter((name) => /\.(?:html|css|js)$/.test(name))
    .map((name) => path.join(root, name));
  for (const file of webRuntimeFiles) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /(?:src|href|require|import)[^\n]*miniprogram-app\//,
      `${path.basename(file)} must not import Mini Program runtime files`);
    assert.doesNotMatch(source, /(?:src|href|require|import)[^\n]*native-app\//,
      `${path.basename(file)} must not import future native App runtime files`);
  }

  for (const file of filesUnder(miniRoot).filter((name) => name.endsWith(".js"))) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/require\(["'](\.[^"']*)["']\)/g)) {
      const resolved = path.resolve(path.dirname(file), match[1]);
      assert.ok(resolved === miniRoot || resolved.startsWith(`${miniRoot}${path.sep}`),
        `${path.relative(root, file)} must not import outside the Mini Program root`);
    }
  }
});

test("repository instructions preserve delivery and client isolation rules", () => {
  const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  const context = fs.readFileSync(path.join(root, "PROJECT_CONTEXT.md"), "utf8");

  assert.match(agents, /deployments\/<function>-v<version>\.zip/);
  assert.match(agents, /database\/cloudbase-console\/<number>-<purpose>\.sql/);
  assert.match(agents, /push the\s+current branch to `origin`/);
  assert.match(agents, /future native application must be created under `native-app\/`/);
  assert.match(context, /客户端物理隔离/);
});
