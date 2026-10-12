const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const cloud = read("cloudfunctions/staffAccount/index.js");
const cloudReadme = read("cloudfunctions/staffAccount/README.md");
const cloudPackage = JSON.parse(read("cloudfunctions/staffAccount/package.json"));
const migration = read("database/migrations/086_training_materials.sql");
const consoleMigration = read("database/cloudbase-console/086-01-training-materials.sql");
const verify = read("database/cloudbase-console/086-readonly-verify.sql");
const appJson = read("miniprogram-app/miniprogram/app.json");
const app = read("miniprogram-app/miniprogram/app.js");
const home = read("miniprogram-app/miniprogram/pages/home/index.wxml");
const homeJs = read("miniprogram-app/miniprogram/pages/home/index.js");
const page = read("miniprogram-app/miniprogram/pages/training-materials/index.js");
const pageMarkup = read("miniprogram-app/miniprogram/pages/training-materials/index.wxml");
const pageStyles = read("miniprogram-app/miniprogram/pages/training-materials/index.wxss");
const queue = read("miniprogram-app/miniprogram/services/training-material-upload-queue.js");
const cache = read("miniprogram-app/miniprogram/services/training-material-cache.js");
const webHtml = read("training-materials.html");
const webCss = read("training-materials.css");
const webJs = read("training-materials.js");
const authUi = read("auth-ui.js");
const phoneAuth = read("cloudbase-phone-auth.js");

test("staffAccount v96 and migration 086 define the private training library", () => {
  assert.match(cloud, /const FUNCTION_VERSION = "v96"/);
  assert.equal(cloudPackage.version, "96.0.0");
  assert.match(cloudReadme, /当前版本：`v96`/);
  assert.equal(consoleMigration, migration);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.training_materials/);
  assert.match(migration, /client_request_id VARCHAR\(64\) NOT NULL UNIQUE/);
  assert.match(migration, /file_bytes BETWEEN 8 AND 104857600/);
  assert.match(migration, /material_status IN \('PUBLISHED', 'ARCHIVED'\)/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.training_materials FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON TABLE public\.training_materials TO service_role/);
  assert.doesNotMatch(migration, /GRANT[^;]*DELETE[^;]*training_materials/);
  assert.match(migration, /INSERT INTO storage\.buckets[\s\S]*'training-materials'[\s\S]*FALSE[\s\S]*104857600[\s\S]*'application\/pdf'/);
  assert.equal((verify.match(/'READY'/g) || []).length, 5);
});

test("service keeps HQ management, active-teacher reading and store denial separate", () => {
  assert.match(cloud, /if \(!\['hq', 'teacher'\]\.includes\(role\)\)/);
  assert.match(cloud, /async function getTrainingMaterialAccess\(caller, event\)[\s\S]*requireTrainingReader\(caller\)/);
  assert.match(cloud, /role === "teacher"[\s\S]*teacherStatus[\s\S]*!== "ACTIVE"/);
  for (const action of [
    "beginTrainingMaterialUpload", "confirmTrainingMaterialUpload",
    "discardTrainingMaterialUpload", "setTrainingMaterialStatus"
  ]) {
    assert.match(cloud, new RegExp(`action === "${action}"[\\s\\S]{0,100}requireHq\\(caller\\)`));
  }
  assert.match(cloud, /material\.title ILIKE '%' \|\|/);
  assert.match(cloud, /role === "hq" \? "material\.material_status IN \('PUBLISHED', 'ARCHIVED'\)" : "material\.material_status = 'PUBLISHED'"/);
  assert.match(cloud, /if \(status !== "ARCHIVED"\) fail\("培训资料只能下架，不能重新发布"/);
  assert.match(cloud, /prefix\.toString\("ascii", 0, 5\) !== "%PDF-"/);
  assert.match(cloud, /expiresIn: 300/);
  assert.match(cloud, /sameTrainingMaterialRequest/);
  assert.match(cloud, /IDEMPOTENCY_CONFLICT/);
  assert.doesNotMatch(cloud, /action === "deleteTrainingMaterial"/);
});

test("mini-program exposes a simple role-specific training interface", () => {
  assert.match(appJson, /pages\/training-materials/);
  assert.match(home, /session\.role === 'teacher'[\s\S]*>学习<\/view>/);
  assert.match(home, /learningMenuOpen[\s\S]*openTrainingMaterials">培训学习/);
  assert.match(home, /managementMenuOpen[\s\S]*openTrainingMaterials">培训学习/);
  assert.doesNotMatch(home, /overviewMenuOpen[\s\S]{0,260}openTrainingMaterials/);
  assert.match(homeJs, /!\["hq", "teacher"\]\.includes/);
  assert.match(page, /requireSession\(\["hq", "teacher"\]\)/);
  assert.match(pageMarkup, /placeholder="按标题搜索"/);
  assert.doesNotMatch(pageMarkup, /分类（可选）|reader-note|总部权限/);
  assert.match(pageMarkup, /bindtap="archiveMaterial"[^>]*>删除<\/button>/);
  assert.doesNotMatch(pageMarkup, /重新发布/);
  assert.doesNotMatch(pageMarkup, /暂未上传培训资料|暂无已发布的培训资料/);
  assert.match(page, /status: "ARCHIVED"/);
  assert.doesNotMatch(page, /重新发布/);
  assert.match(pageStyles, /\.page-heading \{[^}]*justify-content: space-between/);
  assert.match(pageStyles, /\.back \{[^}]*width: 176rpx !important;[^}]*display: flex;[^}]*justify-content: center/);
  assert.match(pageStyles, /@media \(max-width: 699px\)[\s\S]*\.upload-grid \{ display: flex; flex-direction: column; align-items: stretch; \}/);
  assert.match(pageStyles, /\.search-row button \{ width: 128rpx !important; min-width: 128rpx; flex: 0 0 128rpx/);
  assert.match(pageMarkup, /class="field action-field"[\s\S]*class="field-label">操作<\/text>[\s\S]*class="primary publish-button \{\{busy \|\| !selectedFile \|\| !title \? 'is-disabled' : ''\}\}"/);
  assert.match(pageMarkup, /bindtap="uploadPdf" disabled="\{\{busy \|\| !selectedFile \|\| !title\}\}"/);
  assert.match(pageStyles, /\.action-field \.field-label \{ visibility: hidden; \}/);
  assert.match(page, /不支持的操作\|unsupported\|unknown action/);
});

test("teacher PDF reading is full-screen, privately cached, and has no save or share entry", () => {
  assert.match(page, /training-material-cache/);
  assert.match(page, /materialCache\.find\(material\)/);
  assert.match(page, /materialCache\.store\(filePath, material\)/);
  assert.match(page, /wx\.downloadFile/);
  assert.match(page, /wx\.openDocument\(\{[\s\S]*fileType: "pdf", showMenu: false/);
  assert.doesNotMatch(pageMarkup, /web-view|pdf-canvas|reader-toolbar/);
  assert.doesNotMatch(page, /wx\.saveFile|wx\.saveFileToDisk|wx\.shareFileMessage/);
  assert.doesNotMatch(pageMarkup, />下载<|>转发<|>保存</);
  assert.match(cache, /training-material-private-cache-v1/);
  assert.match(cache, /120 \* 1024 \* 1024/);
  assert.match(cache, /copyFile\(tempFilePath, filePath\)/);
  assert.match(cache, /lastOpenedAt/);
  assert.match(cache, /cache size mismatch/);
});

test("HQ PDF uploads persist by owner and resume outside the page", () => {
  assert.match(queue, /training-material-upload-queue-v1/);
  assert.match(queue, /ownerStaffId/);
  assert.match(queue, /clientRequestId/);
  assert.match(queue, /wx\.setStorageSync/);
  assert.match(queue, /wx\.env\.USER_DATA_PATH|filePath/);
  assert.match(queue, /beginTrainingMaterialUpload/);
  assert.match(queue, /confirmTrainingMaterialUpload/);
  assert.match(app, /session\.role === "hq"[\s\S]*trainingMaterialUploadQueue\.resume/);
  assert.match(app, /ownerStaffId: session\.staffId/);
  assert.match(page, /uploadQueue\.enqueue/);
});

test("HQ Web shares the same concise private training library contract", () => {
  assert.match(authUi, /hq: new Set\(\[[\s\S]*"training-materials\.html"/);
  assert.match(authUi, /\["training-materials\.html", "培训学习"\]/);
  const storeAccess = authUi.slice(authUi.indexOf("store: new Set"), authUi.indexOf("teacher: new Set"));
  const teacherAccess = authUi.slice(authUi.indexOf("teacher: new Set"), authUi.indexOf("};", authUi.indexOf("teacher: new Set")));
  assert.doesNotMatch(storeAccess, /training-materials\.html/);
  assert.doesNotMatch(teacherAccess, /training-materials\.html/);
  assert.match(webHtml, /id="trainingTitle"[^>]*required/);
  assert.match(webHtml, /id="trainingFile"[^>]*accept="application\/pdf,\.pdf"/);
  assert.match(webHtml, /id="trainingFilePicker"[^>]*>选择 PDF<\/span>/);
  assert.match(webHtml, /placeholder="按标题搜索"/);
  assert.doesNotMatch(webHtml, /分类|说明文字|下载 PDF/);
  assert.match(webCss, /\.training-upload-form \{[^}]*grid-template-columns:/);
  assert.match(webCss, /\.training-file-picker \{[^}]*align-items: center;[^}]*justify-content: center/);
  assert.match(webCss, /\.training-list\.is-empty \{ display: none; \}/);
  assert.match(webJs, /beginTrainingMaterialUpload/);
  assert.match(webJs, /confirmTrainingMaterialUpload/);
  assert.match(webJs, /setTrainingMaterialStatus/);
  assert.match(webJs, /status: "ARCHIVED"/);
  assert.doesNotMatch(webJs, /重新发布/);
  assert.match(webJs, /window\.open\("about:blank", "_blank"\)/);
  assert.match(phoneAuth, /listTrainingMaterials/);
  assert.match(phoneAuth, /getTrainingMaterialAccess/);
});
