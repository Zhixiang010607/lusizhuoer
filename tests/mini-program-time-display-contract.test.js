const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
function read(relative) { return fs.readFileSync(path.join(root, relative), "utf8"); }

test("every mini-program business time surface uses the shared multi-alias formatter", () => {
  const query = read("miniprogram-app/miniprogram/services/query-tools.js");
  assert.match(query, /function displayDateTimeAny\(\.\.\.values\)/);
  assert.match(query, /\["\$numberLong", "\$numberInt", "\$numberDouble"/);
  assert.match(query, /Object\.prototype\.toString\.call\(current\) === "\[object Date\]"/);
  assert.match(query, /item\.applicationTime, item\.application_time, item\.createdAt, item\.created_at/);

  const expectations = [
    ["miniprogram-app/miniprogram/pages/order-detail/index.js", /reviewedAt:\s*query\.displayDateTimeAny\([\s\S]*original_reviewed_at/],
    ["miniprogram-app/miniprogram/pages/reviews/index.js", /submittedAt:\s*displayDateTimeAny\([\s\S]*original_submitted_at/],
    ["miniprogram-app/miniprogram/pages/reviews/index.js", /reviewedAt:\s*status === "PENDING" \? "—" : displayDateTimeAny/],
    ["miniprogram-app/miniprogram/pages/product-purchase-detail/index.js", /submittedAt:\s*displayDateTimeAny\([\s\S]*row\.created_at/],
    ["miniprogram-app/miniprogram/pages/product-purchase-detail/index.js", /reviewedAt:\s*status === "PENDING" \? "—" : displayDateTimeAny/],
    ["miniprogram-app/miniprogram/pages/customer-detail/index.js", /submittedAtLabel:\s*query\.displayDateTimeAny\([\s\S]*row\.created_at/],
    ["miniprogram-app/miniprogram/pages/customer-detail/index.js", /createdAtLabel:\s*query\.displayDateTimeAny\([\s\S]*row\.message_time/],
    ["miniprogram-app/miniprogram/services/home-dashboard.js", /submittedAt:\s*displayDateTimeAny\([\s\S]*item\.created_at/],
    ["miniprogram-app/miniprogram/pages/teacher-detail/index.js", /at:\s*formatTime\(row\.createdAt, row\.created_at,[\s\S]*row\.event_at/],
    ["miniprogram-app/miniprogram/pages/product-detail/index.js", /updatedText:\s*formatTime\(candidate\.updatedAt, candidate\.updated_at/]
  ];
  expectations.forEach(([file, pattern]) => assert.match(read(file), pattern, `${file} must not collapse a real time into a dash`));
});
