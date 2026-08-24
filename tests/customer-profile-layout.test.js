const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const html = fs.readFileSync(path.join(root, "customer-detail.html"), "utf8");
const ui = fs.readFileSync(path.join(root, "customer-profile.js"), "utf8");
const cloud = fs.readFileSync(path.join(root, "cloudfunctions", "faceRecognition", "index.js"), "utf8");

const desktopBlock = css.match(/@media \(min-width: 900px\) and \(min-height: 760px\) \{([\s\S]*?)\n\}/)?.[1] || "";
const desktopBodyRule = desktopBlock.match(/body\[data-customer-profile\] \{([^}]*)\}/)?.[1] || "";

assert.ok(desktopBlock, "customer profile desktop media block should exist");
assert.match(desktopBlock, /body\[data-customer-profile\] \{[^}]*height: auto;[^}]*overflow-y: auto;/, "desktop customer profile must use page scrolling");
assert.doesNotMatch(desktopBodyRule, /(?:^|;\s*)height:\s*100dvh/, "desktop customer profile must not lock the page to one viewport");
assert.match(desktopBlock, /\.customer-profile-main \{[^}]*grid-auto-rows: auto;[^}]*overflow: visible;/, "profile sections must grow to their natural height");
assert.doesNotMatch(desktopBlock, /grid-template-rows:\s*178px/, "customer header must not be compressed into the old fixed row");
assert.match(desktopBlock, /\.customer-project-panel \.customer-record-scroll \{[^}]*height: 166px;[^}]*max-height: 166px;/, "project records should keep their own bounded scroll area");
assert.match(desktopBlock, /\.customer-record-panel \.customer-record-scroll \{[^}]*height: 158px;[^}]*max-height: 158px;/, "order records should keep their own bounded scroll area");
assert.match(html, /styles\.css\?v=0\.15\.44/, "customer page should bust the stylesheet cache");
assert.match(html, /id="customerExperienceRecords"/, "customer profile must expose a separate experience record list");
assert.match(html, /id="editCustomerNotes"[\s\S]*id="saveCustomerNotes"/, "customer notes must require explicit edit and save actions");
assert.match(html, /class="customer-notes-title-row"[\s\S]*<h2>客户备注<\/h2>[\s\S]*class="customer-notes-actions"/, "customer note actions must sit immediately beside the title");
assert.match(css, /\.customer-notes-title-row \{[^}]*display: flex;[^}]*align-items: center;[^}]*gap: 10px;/, "customer note title and actions must use a compact shared row");
assert.match(html, /class="customer-notes-messages-grid"[\s\S]*customer-notes-panel[\s\S]*customer-messages-panel/, "customer notes and messages must share the same layout row");
assert.match(ui, /action:"updateCustomerNotes"/, "customer notes must save through the database service");
assert.match(ui, /const canEditNotes = \["hq", "store", "teacher"\]/, "HQ, store and teacher may edit customer notes");
assert.match(html, /customer-profile\.js\?v=0\.15\.13/, "customer business-teacher display must bust the profile script cache");
assert.match(ui, /EXPERIENCE:\s*\{ hasMore:false/, "experience records must paginate independently");
assert.match(cloud, /async function updateCustomerNotes\(event\)/, "cloud function must persist customer notes");
assert.match(cloud, /async function updateCustomerNotes\(event\) \{[\s\S]*await activeCustomerProfileCaller\(\)[\s\S]*findCustomerForNotes/, "note writes must use the teacher-aware customer profile scope");
assert.match(cloud, /UPDATE public\.customers AS c[\s\S]*\$\{customerProfileScope\(caller, "c"\)\}[\s\S]*COALESCE\(c\.notes, ''\)/, "teacher note writes remain limited to linked customers through a valid SQL alias");
assert.match(cloud, /\["RECHARGE", "VERIFICATION", "EXPERIENCE"\]/, "customer history API must accept experience history");
assert.equal((html.match(/<th>业务老师<\/th>/g) || []).length, 3, "recharge, verification and experience histories must display a business-teacher column");
assert.match(ui, /function businessTeacher\(row\)[\s\S]*row\?\.teacherName[\s\S]*row\?\.teacherCode/, "customer histories must render only the server-provided business teacher");
assert.match(cloud, /LEFT JOIN public\.teachers business_teacher[\s\S]*business_teacher\.id = r\.teacher_id/, "recharge history must display the teacher selected on the order");
assert.match(cloud, /LEFT JOIN public\.teachers business_teacher[\s\S]*business_teacher\.id = v\.teacher_id/, "verification and experience history must display the teacher selected on the order");
assert.doesNotMatch(cloud, /business_teacher\.staff_account_id = [rv]\.submitted_by_account_id/, "store-submitted orders must not hide their selected business teacher");

const phoneBlock = css.slice(css.lastIndexOf("/* On phones the document owns vertical scrolling."));
assert.match(phoneBlock, /customer-basic-recent \.customer-recent-info \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, "phone customer timestamps and status must use a two-column layout");
assert.match(phoneBlock, /customer-project-panel \.customer-record-scroll table,[\s\S]*customer-record-panel \.customer-record-scroll table \{[^}]*width: max-content;[^}]*min-width: 100%;[^}]*table-layout: auto;/, "phone customer tables must fit short content and scroll only when content is wider");
assert.match(phoneBlock, /customer-project-panel \.customer-record-scroll th,[\s\S]*customer-record-panel \.customer-record-scroll td \{[^}]*width: auto;[^}]*padding: 6px;/, "phone customer table columns must use compact content-driven spacing");
assert.doesNotMatch(html, /<h2>核销记录<\/h2>[\s\S]*?<th>核销类型<\/th>/, "customer verification history must omit verification type");
assert.doesNotMatch(html, /<h2>体验记录<\/h2>[\s\S]*?<th>审核结果<\/th>/, "customer experience history must omit review result");
assert.match(phoneBlock, /customer-notes-panel textarea \{[\s\S]*min-height: 150px[\s\S]*overflow-y: auto/, "phone customer notes must provide a large vertical reading area");
assert.match(phoneBlock, /customer-photo-frame \{[\s\S]*max-width: 100%[\s\S]*margin: 3px auto 9px/, "phone customer photo must remain inside its card with lower spacing");
assert.match(css, /customer-photo-placeholder \{[^}]*font-size: 11px;[^}]*line-height: 1\.45;[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word;/, "customer photo status text must wrap inside the photo frame");

console.log("customer profile layout contract: ok");
