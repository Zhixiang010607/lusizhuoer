const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("every production Web page avoids locale-dependent native date and month pickers", () => {
  const htmlFiles = fs.readdirSync(root).filter((name) => name.endsWith(".html"));
  for (const file of htmlFiles) {
    const html = read(file);
    assert.doesNotMatch(html, /type=["'](?:date|month|week|time|datetime-local)["']/i, `${file} must not expose a browser-native date or time picker`);
    if (html.includes("data-chinese-date")) {
      assert.match(html, /auth-ui\.js\?v=0\.21\.3/, `${file} must load the current Chinese date controller`);
    }
  }
});

test("the shared Web date controller is global, Chinese-only and source inputs are inert", () => {
  const auth = read("auth-ui.js");
  assert.match(auth, /querySelectorAll\("input\[data-chinese-date\]"\)/);
  assert.doesNotMatch(auth, /document\.body\.matches\("\[data-query\]/, "Chinese date controls must not be limited to selected page types");
  assert.match(auth, /星期日.*星期一.*星期二.*星期三.*星期四.*星期五.*星期六/);
  assert.match(auth, /日<\/span><span>一<\/span><span>二<\/span><span>三<\/span><span>四<\/span><span>五<\/span><span>六<\/span>/);
  assert.match(auth, /input\.type = "hidden"/);
  assert.match(auth, /input\.disabled \|\| input\.readOnly/);
  assert.doesNotMatch(auth, /Intl\.DateTimeFormat\("en-CA"/);
});

test("the work calendar uses an explicit Chinese year-month selector", () => {
  const html = read("work-calendar.html");
  const client = read("work-calendar.js");
  assert.match(html, /<select id="workMonth" aria-label="选择年月"><\/select>/);
  assert.match(html, /work-calendar\.js\?v=1\.0\.1/);
  assert.match(client, /new Option\(`\$\{year\}年\$\{month\}月`, value\)/);
  assert.doesNotMatch(client, /Intl\.DateTimeFormat\("en-CA"/);
});
