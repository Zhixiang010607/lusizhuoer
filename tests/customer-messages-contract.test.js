"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const migration = read("database", "migrations", "042_customer_messages.sql");
const consoleMigration = read("database", "cloudbase-console", "042-01-customer-messages.sql");
const cloud = read("cloudfunctions", "faceRecognition", "index.js");
const html = read("customer-detail.html");
const ui = read("customer-profile.js");
const css = read("styles.css");
const auth = read("auth-ui.js");
const teacherUi = read("teacher-work-orders.js");
const teacherHtml = read("teacher-work-orders.html");

for (const source of [migration, consoleMigration]) {
  assert.match(source, /CREATE TABLE IF NOT EXISTS public\.customer_messages/);
  assert.match(source, /REFERENCES public\.customers\(id\) ON DELETE RESTRICT/);
  assert.match(source, /REFERENCES public\.staff_accounts\(id\) ON DELETE RESTRICT/);
  assert.match(source, /author_role IN \('hq', 'store', 'teacher'\)/);
  assert.match(source, /CHAR_LENGTH\(BTRIM\(message_content\)\) BETWEEN 1 AND 100/);
  assert.match(source, /customer_id, created_at DESC, id DESC/);
  assert.match(source, /BEFORE UPDATE OR DELETE ON public\.customer_messages/);
  assert.match(source, /REVOKE ALL ON TABLE public\.customer_messages FROM PUBLIC/);
}

assert.match(cloud, /const FUNCTION_VERSION = PHOTO_ONLY_FUNCTION \? "v9" : "v100"/);
assert.match(cloud, /async function listCustomerMessages\(event\)/);
assert.match(cloud, /async function addCustomerMessage\(event\)/);
assert.match(cloud, /const limit = Number\.isFinite\(requestedLimit\)[\s\S]*?: 20;/);
assert.match(cloud, /Math\.min\(Math\.max\(Math\.trunc\(requestedLimit\), 1\), 50\)/);
assert.match(cloud, /ORDER BY cm\.created_at DESC, cm\.id DESC/);
assert.match(cloud, /Array\.from\(content\)\.length/);
assert.match(cloud, /WITH inserted_message AS \([\s\S]*INSERT INTO public\.customer_messages[\s\S]*SELECT[\s\S]*a\.id, a\.role_code,[\s\S]*BTRIM\(a\.staff_name\)[\s\S]*RETURNING[\s\S]*FROM inserted_message/, "CloudBase must receive message rows through a SELECT around the writable CTE");
assert.doesNotMatch(cloud, /event\.(?:authorName|authorRole)/, "author identity must never be accepted from the browser");
assert.match(cloud, /account\.role_code === "teacher"/);
assert.match(cloud, /teacherBusinessAttributionCondition\(caller, "teacher_verification", "VERIFICATION"\)/);
const teacherCustomerScope = cloud.slice(cloud.indexOf("function teacherCustomerAccessCondition"), cloud.indexOf("function customerStatusCode"));
assert.match(teacherCustomerScope, /verification_type IN \('NORMAL', 'EXPERIENCE'\)/, "teacher profile access must include approved normal or experience verification");
assert.match(teacherCustomerScope, /teacher_recharge[\s\S]*record_status = 'APPROVED'[\s\S]*recharge_type IN \('NEW', 'REFUND'\)/, "teacher profile access must include approved recharge or refund");
assert.match(cloud, /if \(action === "listCustomerMessages"\)/);
assert.match(cloud, /if \(action === "addCustomerMessage"\)/);

const notesIndex = html.indexOf('class="panel customer-notes-panel"');
const messagesIndex = html.indexOf('id="customerMessagesPanel"');
const projectsIndex = html.indexOf('class="panel customer-project-panel"');
assert.ok(notesIndex >= 0 && notesIndex < messagesIndex && messagesIndex < projectsIndex, "customer messages must sit directly below notes and before project totals");
assert.match(html, /class="customer-notes-messages-grid"[\s\S]*class="panel customer-notes-panel"[\s\S]*id="customerMessagesPanel"/, "notes and messages must share one responsive grid");
assert.match(html, /id="customerMessageInput"[^>]*maxlength="100"/);
assert.match(html, /id="customerMessageList"[^>]*tabindex="0"/);
assert.match(html, /customer-profile\.js\?v=0\.15\.16/);
assert.match(html, /auth-ui\.js\?v=0\.19\.7/);

assert.match(ui, /hq:"总部", store:"门店", teacher:"老师"/);
assert.match(ui, /年\$\{match\[2\]\}月\$\{match\[3\]\}日 \$\{match\[4\]\}:\$\{match\[5\]\}:\$\{match\[6\]\}/);
assert.match(ui, /action:"listCustomerMessages"/);
assert.match(ui, /messageLimit:20/);
assert.match(ui, /cursorCreatedAt = customerMessageNextCursor\.createdAt/);
assert.match(ui, /action:"addCustomerMessage"/);
assert.match(ui, /customerMessages\.unshift\(data\.message\)/);
assert.match(ui, /items\.slice\(0, 5\)\.reduce/, "desktop message height must be calculated from the first five complete messages");
assert.match(ui, /list\.style\.maxHeight = `\$\{Math\.ceil\(visibleHeight\)\}px`/, "the sixth message must overflow inside the message list");
assert.match(ui, /session\?\.role === "teacher"[\s\S]*teacher-work-orders\.html/);

assert.match(css, /\.customer-message-list \{[^}]*max-height: 360px;[^}]*overflow-y: auto;/);
assert.match(css, /\.customer-message-content \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/);
assert.match(css, /@media \(min-width: 1101px\)[\s\S]*customer-notes-messages-grid \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, "desktop notes and messages must use equal-width columns");
assert.match(css, /@media \(min-width: 1101px\)[\s\S]*customer-notes-panel,[\s\S]*customer-messages-panel \{[\s\S]*height: 100%/, "desktop notes and messages must be equal height");
assert.match(css, /@media \(min-width: 1101px\)[\s\S]*customer-message-list \{[\s\S]*max-height: none;/, "desktop JS must own the exact five-message height cap");
assert.match(css, /@media \(min-width: 761px\) and \(max-width: 1100px\)[\s\S]*customer-message-list \{ max-height: min\(42dvh, 380px\); \}/);
assert.match(css, /@media \(max-width: 760px\)[\s\S]*customer-message-list \{[\s\S]*max-height: min\(46dvh, 340px\)/);
assert.match(css, /customer-message-compose \{[\s\S]*grid-template-columns: 1fr;[\s\S]*customer-message-compose button \{ width: 100%; \}/);

assert.match(auth, /teacher: new Set\(\[[^\]]*"customer-detail\.html"/);
assert.match(teacherUi, /customer-detail\.html\?\$\{customerParams\.toString\(\)\}/);
assert.match(teacherHtml, /点击单号查看凭证，点击客户可进入关联客户主页/);
assert.match(teacherHtml, /teacher-work-orders\.js\?v=0\.16\.5/);

console.log("customer messages contract: PASS");
