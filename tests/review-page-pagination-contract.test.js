"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const review = read("review.js");
const phoneAuth = read("cloudbase-phone-auth.js");
const staffAccount = read("cloudfunctions/staffAccount/index.js");

for (const page of ["recharge-review.html", "refund-review.html", "verification-review.html"]) {
  const html = read(page);
  assert.match(html, /id="reviewPagination"/, `${page} exposes a pager`);
  assert.match(html, /id="reviewPreviousPage"/, `${page} has previous page`);
  assert.match(html, /id="reviewNextPage"/, `${page} has next page`);
  assert.match(html, /id="reviewPageInput"[^>]*type="number"/, `${page} accepts a direct page number`);
  assert.match(html, /id="reviewPageJump"/, `${page} can jump directly`);
  assert.doesNotMatch(html, /reviewLoadMore/, `${page} must not append an endless review list`);
  assert.match(html, /review\.js\?v=0\.18\.3/, `${page} loads the page-pager UI`);
}

assert.match(review, /const PAGE_SIZE = 100;/);
assert.match(review, /function renderPagination\(\)/);
assert.match(review, /pageNumber: queryMode === "filters" \? targetPage : null/);
assert.match(review, /function jumpToPage\(value\)/);
assert.match(review, /请输入 1 到 \$\{safeTotalPages\} 之间的页码/);
assert.match(review, /void refresh\(\{ requestedPage: targetPage \}\)/);
assert.doesNotMatch(review, /append\s*:\s*true|reviewLoadMore/, "review UI must request one page rather than append rows");

assert.match(phoneAuth, /pageNumber = null/);
assert.match(phoneAuth, /payload\.pageNumber = pageNumber/);
assert.match(phoneAuth, /totalPages: Number\(data\.totalPages \|\| 0\)/);

assert.match(staffAccount, /const FUNCTION_VERSION = "v74"/);
assert.match(staffAccount, /const pageNumberValue = event\.pageNumber;/);
assert.match(staffAccount, /requestedPageNumber > 10000/);
assert.match(staffAccount, /if \(hasCursor && hasPageNumber\) fail\("审核列表不能同时使用页码与游标", "BAD_REQUEST"\);/);
assert.match(staffAccount, /const pageOffsetPagination = paged && hasPageNumber;/);
assert.match(staffAccount, /SELECT COUNT\(\*\) AS total/);
assert.match(staffAccount, /const pageOffset = \(pageNumber - 1\) \* limit;/);
assert.match(staffAccount, /LIMIT \$\{limit\} OFFSET \$\{pageOffset\}/);
assert.match(staffAccount, /hasMore: pageNumber < totalPages/);
assert.match(staffAccount, /ORDER BY \(\$\{statusExpression\} = 'PENDING'\) DESC, \$\{timeExpression\} DESC/);
assert.match(staffAccount, /nextCursor: hasMore && last/, "legacy cursor callers remain supported");

console.log("review page pagination contract: PASS");
