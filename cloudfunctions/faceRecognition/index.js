"use strict";

const cloudbase = require("@cloudbase/node-sdk");
const CloudBaseManager = require("@cloudbase/manager-node");
const tencentcloud = require("tencentcloud-sdk-nodejs");
const IaiClient = tencentcloud.iai.v20180301.Client;

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
let cloudApp = null;
let managerClient = null;

function app() {
  if (!cloudApp) cloudApp = cloudbase.init({});
  return cloudApp;
}

function manager() {
  if (!managerClient) managerClient = CloudBaseManager.init({ envId: process.env.TCB_ENV });
  return managerClient;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing cloud function environment variable: ${name}`);
  return value;
}

function fail(message, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function sqlText(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function parseSqlRows(result) {
  const columns = result?.Columns || [];
  return (result?.Rows || []).map((raw) => {
    const values = Array.isArray(raw) ? raw : JSON.parse(raw);
    return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  });
}

async function executeSql(sql) {
  return parseSqlRows(await manager().database.executePGSql({ Sql: sql }));
}

function faceClient() {
  return new IaiClient({
    credential: { secretId: required("FACE_SECRET_ID"), secretKey: required("FACE_SECRET_KEY") },
    region: "ap-guangzhou",
    profile: { httpProfile: { endpoint: "iai.tencentcloudapi.com" } }
  });
}

function cleanImage(value) {
  if (typeof value !== "string" || !value.trim()) fail("A camera photo is required.");
  const base64 = value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) fail("The camera photo format is invalid.");
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) fail("The camera photo must be between 1 byte and 4 MB.");
  return { base64, buffer };
}

function validDate(value) {
  const date = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("Birth date must use YYYY-MM-DD.");
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) fail("Birth date is invalid.");
  return date;
}

function customerCode(storeId) {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `C${storeId}-${stamp}-${random}`;
}

async function activeStoreCaller() {
  const { uid } = app().auth().getUserInfo();
  if (!uid) fail("Please sign in before creating a customer.", "UNAUTHENTICATED");
  const rows = await executeSql(
    `SELECT a.id AS staff_id, a.role_code, a.account_status, sa.store_id, s.store_status
       FROM public.staff_accounts a
       JOIN public.staff_store_assignments sa
         ON sa.staff_account_id = a.id AND sa.assignment_status = 'ACTIVE'
       JOIN public.stores s ON s.id = sa.store_id
      WHERE a.auth_uid = ${sqlText(uid)}
      LIMIT 1`
  );
  const caller = rows[0];
  if (!caller || caller.role_code !== "store") fail("Only an active store account can create a customer.", "FORBIDDEN");
  if (caller.account_status !== "ACTIVE" || caller.store_status !== "ACTIVE") fail("The store account or store is archived.", "ARCHIVED");
  return { uid: String(uid), staffId: Number(caller.staff_id), storeId: Number(caller.store_id) };
}

async function deleteUploadedFile(fileID) {
  if (!fileID) return;
  try { await app().deleteFile({ fileList: [fileID] }); } catch (error) { console.warn("Photo cleanup failed", error?.message || error); }
}

async function deleteFacePerson(api, groupId, personId) {
  if (!personId) return;
  try { await api.DeletePerson({ GroupId: groupId, PersonId: personId }); } catch (error) { console.warn("Face person cleanup failed", error?.message || error); }
}

async function registerCustomer(event) {
  const caller = await activeStoreCaller();
  const name = String(event.customerName || "").trim();
  const birthDate = validDate(event.birthDate);
  const notes = String(event.notes || "").trim();
  const consent = event.consent === true;
  if (!name || name.length > 64) fail("Customer name is required and must not exceed 64 characters.");
  if (!consent) fail("Explicit customer consent is required before collecting a face photo.", "CONSENT_REQUIRED");
  if (notes.length > 500) fail("Notes must not exceed 500 characters.");

  const duplicate = await executeSql(
    `SELECT customer_code FROM public.customers
      WHERE created_store_id = ${caller.storeId}
        AND customer_name = ${sqlText(name)}
        AND birth_date = ${sqlText(birthDate)}::date
        AND customer_status = 'ACTIVE'
      LIMIT 1`
  );
  if (duplicate[0]) fail(`An active customer already exists: ${duplicate[0].customer_code}`, "DUPLICATE_CUSTOMER");

  const { base64, buffer } = cleanImage(event.imageBase64);
  const groupId = required("FACE_GROUP_ID");
  const personId = customerCode(caller.storeId);
  const api = faceClient();
  let fileID = "";
  let personCreated = false;
  try {
    const faceResult = await api.CreatePerson({
      GroupId: groupId,
      PersonId: personId,
      PersonName: name,
      Image: base64,
      UniquePersonControl: 1
    });
    personCreated = true;
    const cloudPath = `customer-photos/${caller.storeId}/${personId}/${Date.now()}.jpg`;
    const upload = await app().uploadFile({ cloudPath, fileContent: buffer });
    fileID = String(upload?.fileID || "");
    if (!fileID) fail("Photo storage did not return a file identifier.", "STORAGE_ERROR");
    const saved = await executeSql(
      `INSERT INTO public.customers
        (customer_code, customer_name, birth_date, notes, profile_photo_file_id, photo_captured_at,
         face_person_id, face_consent_at, customer_status, customer_process_status, created_store_id)
       VALUES
        (${sqlText(personId)}, ${sqlText(name)}, ${sqlText(birthDate)}::date, ${sqlText(notes)}, ${sqlText(fileID)}, NOW(),
         ${sqlText(personId)}, NOW(), 'ACTIVE', 'INFORMATION_ONLY', ${caller.storeId})
       RETURNING id, customer_code, profile_photo_file_id, face_person_id, created_at`
    );
    const customer = saved[0];
    if (!customer) fail("Customer record was not returned after creation.", "DATABASE_ERROR");
    return {
      ok: true,
      customer: {
        id: String(customer.id),
        customerCode: customer.customer_code,
        customerName: name,
        birthDate,
        photoFileId: customer.profile_photo_file_id,
        facePersonId: customer.face_person_id,
        faceId: faceResult.FaceId || "",
        createdAt: customer.created_at
      }
    };
  } catch (error) {
    await deleteUploadedFile(fileID);
    if (personCreated) await deleteFacePerson(api, groupId, personId);
    throw error;
  }
}

async function searchCustomer(event) {
  const { base64 } = cleanImage(event.imageBase64);
  const result = await faceClient().SearchFaces({ Image: base64, GroupIds: [required("FACE_GROUP_ID")], MaxFaceNum: 1, FaceMatchThreshold: 80 });
  const candidate = result.Results?.[0]?.Candidates?.[0];
  if (!candidate) return { ok: true, matched: false, message: "No enrolled customer was matched." };
  return { ok: true, matched: true, customerId: candidate.PersonId, score: candidate.Score };
}

exports.main = async (event = {}) => {
  try {
    const action = event.action || "health";
    if (action === "health") return { ok: true, groupId: required("FACE_GROUP_ID"), message: "Face customer enrollment is ready." };
    if (action === "registerCustomer") return await registerCustomer(event);
    if (action === "searchCustomer") return await searchCustomer(event);
    fail("Unsupported action.");
  } catch (error) {
    console.error("faceRecognition failed", { action: event?.action || "health", code: error?.code || "FUNCTION_ERROR", message: error?.message || String(error) });
    return { ok: false, code: error?.code || "FUNCTION_ERROR", message: error?.message || "Customer enrollment failed." };
  }
};
