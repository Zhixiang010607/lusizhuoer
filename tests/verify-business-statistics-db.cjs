"use strict";

// Runs the real SQL generators and ledger functions against synthetic PostgreSQL
// only. No database URL, CloudBase SDK, credentials or production data is used.
// Usage: node tests/verify-business-statistics-db.cjs /absolute/path/to/@electric-sql/pglite
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const part = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a, `Source boundaries: ${start}`);
  return source.slice(a, b);
};
const fnSql = (file, name) => {
  const source = read(file), a = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert(a >= 0, `Canonical SQL function ${name}`);
  const body = source.indexOf("AS $$", a), end = source.indexOf("$$;", body + 5);
  assert(body > a && end > body);
  return source.slice(a, end + 3);
};

async function main() {
  assert(process.argv[2], "Supply local PGlite package path; production connections are not supported");
  const { PGlite } = require(path.resolve(process.argv[2]));
  const db = new PGlite();
  let checks = 0, executedReadQueries = 0;
  const eq = (actual, expected, label) => { assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, label); checks++; };
  const rejects = async (run, pattern) => { await assert.rejects(run, pattern); checks++; };
  const scalar = async sql => Object.values((await db.query(sql)).rows[0])[0];
  const sqlText = value => "'" + String(value ?? "").replace(/'/g, "''") + "'";
  const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
  const numericId = value => { if (!/^[1-9]\d{0,17}$/.test(String(value))) fail("Invalid ID", "BAD_REQUEST"); return String(value); };
  const query = async sql => {
    assert.match(sql.trim(), /^(?:SELECT|WITH)\b/i, "Audited read endpoint must not mutate the ledger");
    assert.doesNotMatch(sql, /\b(?:UPDATE|INSERT|DELETE|ALTER|reset_teacher_experience_quota)\b/i);
    executedReadQueries++;
    try { return (await db.query(sql)).rows; }
    catch(error) { error.message += "\nIsolated SQL:\n" + sql; throw error; }
  };
  try {
    await db.exec(`
      SET TIME ZONE 'Pacific/Honolulu';
      CREATE TABLE staff_accounts(id BIGINT PRIMARY KEY, auth_uid TEXT, role_code TEXT, account_status TEXT DEFAULT 'ACTIVE',phone TEXT DEFAULT '');
      CREATE TABLE teachers(id BIGINT PRIMARY KEY,staff_account_id BIGINT UNIQUE,teacher_code TEXT,teacher_name TEXT,teacher_status TEXT DEFAULT 'ACTIVE');
      CREATE TABLE stores(id BIGINT PRIMARY KEY,store_code TEXT,store_name TEXT,store_status TEXT DEFAULT 'ACTIVE',store_account_id BIGINT,
        province TEXT DEFAULT '',city TEXT DEFAULT '',district TEXT DEFAULT '',address_detail TEXT DEFAULT '');
      CREATE TABLE store_contacts(id BIGINT PRIMARY KEY,store_id BIGINT,contact_name TEXT,contact_phone TEXT,contact_status TEXT,is_primary BOOLEAN);
      CREATE TABLE products(id BIGINT PRIMARY KEY,product_code TEXT,product_name TEXT,product_status TEXT DEFAULT 'ACTIVE');
      CREATE TABLE customers(id BIGINT PRIMARY KEY,customer_code TEXT,customer_name TEXT,birth_date DATE,notes TEXT DEFAULT '',
        customer_status TEXT DEFAULT 'ACTIVE',customer_process_status TEXT DEFAULT 'INFORMATION_ONLY',created_store_id BIGINT,created_by_account_id BIGINT,
        created_at TIMESTAMPTZ DEFAULT '2026-10-01T00:00:00Z',total_recharge_count INT DEFAULT 0,total_verification_count INT DEFAULT 0,
        total_experience_count INT DEFAULT 0,latest_recharge_at TIMESTAMPTZ,latest_verification_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);
      CREATE TABLE recharge_records(id BIGINT PRIMARY KEY,recharge_code TEXT,recharge_type TEXT,original_recharge_id BIGINT,store_id BIGINT,
        teacher_id BIGINT,customer_id BIGINT,product_id BIGINT,unit_count INT CHECK(unit_count BETWEEN 1 AND 999),record_status TEXT,
        submitted_by_account_id BIGINT,submitted_at TIMESTAMPTZ,reviewed_by_account_id BIGINT,reviewed_at TIMESTAMPTZ,message TEXT DEFAULT '',review_note TEXT DEFAULT '',
        idempotency_key TEXT UNIQUE,void_request_status TEXT DEFAULT 'NONE',balance_before_count INT DEFAULT 0,balance_after_count INT DEFAULT 0,updated_at TIMESTAMPTZ);
      CREATE TABLE verification_records(id BIGINT PRIMARY KEY,verification_code TEXT,verification_type TEXT,store_id BIGINT,teacher_id BIGINT,customer_id BIGINT,
        product_id BIGINT,unit_count INT CHECK(unit_count BETWEEN 1 AND 999),record_status TEXT,submitted_by_account_id BIGINT,submitted_at TIMESTAMPTZ,
        reviewed_by_account_id BIGINT,reviewed_at TIMESTAMPTZ,message TEXT DEFAULT '',review_note TEXT DEFAULT '',supplement_note TEXT DEFAULT '',face_request_id TEXT,
        face_subject_type TEXT DEFAULT 'CUSTOMER',face_subject_teacher_id BIGINT,
        idempotency_key TEXT UNIQUE,void_request_status TEXT DEFAULT 'NONE',updated_at TIMESTAMPTZ);
      CREATE TABLE customer_product_balances(customer_id BIGINT,product_id BIGINT,total_recharge_count INT,total_verification_count INT,
        remaining_count INT CHECK(remaining_count>=0),updated_at TIMESTAMPTZ,PRIMARY KEY(customer_id,product_id));
      CREATE TABLE teacher_product_experience_quotas(id BIGINT,teacher_id BIGINT,product_id BIGINT,quota_status TEXT,
        monthly_allowance INT,available_count INT,used_count INT,manual_recharge_count INT,quota_month DATE,monthly_reset_at TIMESTAMPTZ);
      CREATE TABLE retail_products(id BIGINT PRIMARY KEY,product_code TEXT,product_name TEXT,product_status TEXT DEFAULT 'ACTIVE');
      CREATE TABLE retail_product_purchase_records(id BIGINT,customer_id BIGINT,teacher_id BIGINT,store_id BIGINT,retail_product_id BIGINT,unit_count INT,record_status TEXT,
        purchase_code TEXT,product_name_snapshot TEXT,product_code_snapshot TEXT,submitted_at TIMESTAMPTZ,reviewed_at TIMESTAMPTZ,
        submitted_by_account_id BIGINT,reviewed_by_account_id BIGINT,message TEXT DEFAULT '',review_note TEXT DEFAULT '');
      CREATE TABLE recharge_product_gifts(id BIGINT,recharge_id BIGINT,retail_product_id BIGINT,product_name_snapshot TEXT,product_code_snapshot TEXT,unit_count INT,display_order INT,store_id BIGINT,teacher_id BIGINT,customer_id BIGINT);
      INSERT INTO staff_accounts(id,auth_uid,role_code) VALUES(1,'qa-hq','hq'),(2,'qa-store','store'),(3,'qa-store2','store'),(11,'qa-teacher1','teacher'),(12,'qa-teacher2','teacher'),(13,'qa-retired','operation');
      INSERT INTO teachers(id,staff_account_id,teacher_code,teacher_name) SELECT n,10+n,'QA-T-'||n,'合成老师'||n FROM generate_series(1,25)n;
      INSERT INTO stores(id,store_code,store_name,store_account_id) VALUES(1,'QA-S-1','合成门店一',2),(2,'QA-S-2','合成门店二',3),(3,'QA-S-3','无业务门店',NULL);
      INSERT INTO products(id,product_code,product_name) VALUES(1,'QA-P-1','合成项目一'),(2,'QA-P-2','合成项目二'),(3,'QA-P-3','无业务项目');
      INSERT INTO customers(id,customer_code,customer_name,birth_date,created_store_id,created_by_account_id) VALUES(1,'QA-C-1','合成客户一','1990-01-01',1,2),(2,'QA-C-2','合成客户二','2000-01-01',2,12);
    `);
    // This fixture audits business numbers; leadership-name semantics are
    // exercised separately with the real 093 migration.
    await db.exec("CREATE FUNCTION public.teacher_team_leader_name_v93(bigint) RETURNS text LANGUAGE sql STABLE AS $$SELECT ''::text$$");
    const faceSource = read("cloudfunctions/faceRecognition/index.js"), staffSource = read("cloudfunctions/staffAccount/index.js");
    let caller = { role: "hq", scopeMode: "ALL", staffId: 1 };
    const face = vm.createContext({ Number,String,Object,Math,Date,Set,Map,JSON,sqlText,fail,
      positiveDatabaseId:numericId,businessQueryDatabaseId:numericId,validDate:value=>value,
      activeScopedQueryCaller:async()=>caller,activeTeacherCaller:async()=>caller,
      getStoreBindingLayout:async()=>"stores",customerStatusSql:sqlText,
      requireTeacherExperienceQuotaLifecycleSchema:async()=>{},parsedProductGiftRows:rows=>rows||[],
      executeSql:query,databaseBoolean:value=>value===true||value==="true"||value===1||value==="1",
      rechargeProductGiftSchemaAvailable:async()=>true,requireRetailProductPurchaseSchema:async()=>{},
      activeCustomerProfileCaller:async()=>caller
    });
    vm.runInContext(part(faceSource,"function scopedStoreClause(","function teacherTeamReads("),face);
    vm.runInContext(part(faceSource,"function teacherBusinessAttributionSourceCondition(","async function findCustomerStatus("),face);
    vm.runInContext(part(faceSource,"function optionalBusinessQueryDate(","function customerListPageSize("),face);
    vm.runInContext(part(faceSource,"function scopedQueryCursorTimestamp(","function inactiveVerificationCursor("),face);
    vm.runInContext(part(faceSource,"function customerListPageSize(","async function requireTeacherExperienceQuotaLifecycleSchema("),face);
    vm.runInContext(part(faceSource,"const TEACHER_WORKSPACE_TYPES", "async function getHqTeacherWorkspace("),face);
    vm.runInContext(part(faceSource,"function customerHistoryOptions(","async function uploadCustomerPhoto("),face);
    const hq = vm.createContext({ Number,String,Object,Math,Date,Set,Map,JSON,sqlText,fail,numericId,executeSql:query,
      asDatabaseError:(error)=>{throw error;},HQ_DASHBOARD_CHART_LIMIT:10,
      HQ_DASHBOARD_DEFAULT_PAGE_SIZE:100,HQ_DASHBOARD_MAX_PAGE_SIZE:500,HQ_DASHBOARD_MAX_PAGE_NUMBER:10000 });
    vm.runInContext(part(staffSource,"function strictDashboardDate(","function asDatabaseError("),hq);
    vm.runInContext(part(staffSource,"function hqDashboardRow(","async function getHqDashboard(event"),hq);
    const range={startDate:"2026-10-01",endDate:"2026-11-30"};
    const totals = async () => (await hq.getHqDashboardOverview(range)).totals;
    const counts = row => [row.recharge,row.verification,row.experience,row.refund];
    const expectedTotals = async expected => eq(counts(await totals()),expected,"HQ sums approved unit counts by four separate types");
    const balance = async()=>Number(await scalar("SELECT COALESCE(SUM(remaining_count),0) FROM customer_product_balances WHERE customer_id=1"));

    // Real installed-in-source ledger/review functions; keep writes in this
    // local in-memory database. Read endpoint transport rejects any writes.
    for(const [file,name] of [
      ["044_refund_application_workflow.sql","refresh_customer_balance"],
      ["021_customer_product_effective_balances.sql","refresh_customer_balance_after_order"],
      ["058_order_integrity_and_submission_recovery.sql","enforce_current_recharge_integrity"],
      ["079_supplement_verification_review.sql","enforce_current_verification_integrity"],
      ["063_lock_down_database_client_access.sql","enforce_paid_verification_available_balance_v63"],
      ["047_retire_operation_accounts.sql","enforce_hq_order_reviewer"],
      ["047_retire_operation_accounts.sql","review_order_application"]
    ]) await db.exec(fnSql("database/migrations/"+file,name));
    await db.exec(`CREATE TRIGGER qa_recharge_integrity BEFORE INSERT OR UPDATE ON recharge_records FOR EACH ROW EXECUTE FUNCTION enforce_current_recharge_integrity();
      CREATE TRIGGER qa_verification_integrity BEFORE INSERT OR UPDATE ON verification_records FOR EACH ROW EXECUTE FUNCTION enforce_current_verification_integrity();
      CREATE TRIGGER qa_recharge_review BEFORE UPDATE ON recharge_records FOR EACH ROW EXECUTE FUNCTION enforce_hq_order_reviewer();
      CREATE TRIGGER qa_verification_review BEFORE UPDATE ON verification_records FOR EACH ROW EXECUTE FUNCTION enforce_hq_order_reviewer();
      CREATE TRIGGER qa_paid_balance BEFORE INSERT OR UPDATE ON verification_records FOR EACH ROW EXECUTE FUNCTION enforce_paid_verification_available_balance_v63();
      CREATE TRIGGER qa_refresh_recharge AFTER INSERT OR UPDATE ON recharge_records FOR EACH ROW EXECUTE FUNCTION refresh_customer_balance_after_order();
      CREATE TRIGGER qa_refresh_verification AFTER INSERT OR UPDATE ON verification_records FOR EACH ROW EXECUTE FUNCTION refresh_customer_balance_after_order();`);
    const recharge=async(id,type,units,status="PENDING",extra={})=>db.query(`INSERT INTO recharge_records(id,recharge_code,recharge_type,store_id,teacher_id,customer_id,product_id,unit_count,record_status,submitted_by_account_id,submitted_at,idempotency_key)
      VALUES($1,'QA-R-'||$1::bigint::text,$2,$3,$4,$5,$6,$7,$8,$9,$10,'qa:r:'||$1::bigint::text)`,[id,type,extra.store||1,extra.teacher||1,extra.customer||1,extra.product||1,units,status,extra.submitter||2,extra.at||"2026-10-31T16:00:00Z"]);
    const verification=async(id,type,units,status="APPROVED",extra={})=>db.query(`INSERT INTO verification_records(id,verification_code,verification_type,store_id,teacher_id,customer_id,product_id,unit_count,record_status,submitted_by_account_id,submitted_at,idempotency_key)
      VALUES($1,'QA-V-'||$1::bigint::text,$2,$3,$4,$5,$6,$7,$8,$9,$10,'qa:v:'||$1::bigint::text)`,[id,type,extra.store||1,extra.teacher||1,extra.customer||1,extra.product||1,units,status,extra.submitter||11,extra.at||"2026-11-01T00:00:00Z"]);
    const review=(family,id,decision="APPROVED",actor=1)=>db.query("SELECT * FROM review_order_application($1,$2,$3,$4,'合成审核')",[family,id,actor,decision]);
    await expectedTotals([0,0,0,0]);
    await recharge(1,"NEW",20); await expectedTotals([0,0,0,0]); eq(await balance(),0,"Pending recharge gives no available units");
    await rejects(()=>review("RECHARGE",1,"APPROVED",11),/only headquarters/);
    await review("RECHARGE",1); eq(await balance(),20,"Recharge approval gives twenty units once"); await expectedTotals([20,0,0,0]);
    await rejects(()=>review("RECHARGE",1),/no longer pending/); eq(await balance(),20,"Duplicate approval does not add units");
    await verification(1,"EXPERIENCE",4); eq(await balance(),20,"Experience never debits purchased balance"); await expectedTotals([20,0,4,0]);
    await verification(2,"NORMAL",3); eq(await balance(),17,"Normal consumes unit_count, not one row");
    await verification(3,"SUPPLEMENT",2,"PENDING"); eq(await balance(),17,"Pending supplement does not consume balance"); await expectedTotals([20,3,4,0]);
    await review("VERIFICATION",3); eq(await balance(),15,"Approved supplement debits purchased balance"); await expectedTotals([20,5,4,0]);
    await recharge(2,"REFUND",5); eq(await balance(),15,"Pending refund has no balance effect"); await review("RECHARGE",2);
    eq(await balance(),10,"Approved refund debits net purchased balance"); await expectedTotals([20,5,4,5]);
    eq(Number(await scalar("SELECT total_recharge_count FROM customers WHERE id=1")),15,"Storage cache intentionally retains net purchased count");
    caller={role:"hq",scopeMode:"ALL",staffId:1};
    const customerQuery=await face.queryStoreCustomers({limit:10});
    eq(customerQuery.customers.find(c=>c.customerCode==="QA-C-1").totalRechargeCount,20,"Customer query shows gross recharge after refund");
    const exportedCustomers=await face.queryStoreCustomers({exportAll:true,limit:1});
    eq(exportedCustomers.total,exportedCustomers.customers.length,"Customer export is a complete single snapshot");
    const exportedRefunds=await face.queryStoreBusinessRecords({recordType:"RECHARGE",rechargeType:"REFUND",statusCategory:"APPROVED",exportAll:true,page:9,pageSize:10});
    eq(exportedRefunds.records.map(r=>r.unitCount),[5],"Refund export preserves the approved unit count and ignores display page");
    const exportedNormal=await face.queryStoreBusinessRecords({recordType:"VERIFICATION",verificationType:"NORMAL",statusCategory:"APPROVED",exportAll:true});
    eq(exportedNormal.records.map(r=>r.originalType).sort(),["NORMAL","SUPPLEMENT"],"Normal export includes approved supplement, excludes experience");
    caller={role:"hq",scopeMode:"STORE",storeId:1,staffId:1};
    const store=await face.getStoreDashboard({customerPageSize:10});
    eq(Number(store.store.customers.find(c=>c.customer_code==="QA-C-1").total_recharge_count),20,"Store home customer list shows gross recharge after refund");
    caller={role:"hq",scopeMode:"ALL",staffId:1};
    const customerProfile=await face.getCustomerProfile({customerCode:"QA-C-1",historyLimit:20});
    eq(customerProfile.customer.totalVerificationCount,5,"Customer profile normal counter excludes separately displayed experience");
    eq([customerProfile.customer.totalRechargeCount,customerProfile.customer.totalRefundCount,customerProfile.customer.totalExperienceCount],[20,5,4],"Customer profile keeps gross recharge/refund/experience independent");
    eq([customerProfile.balances[0].totalRechargeCount,customerProfile.balances[0].totalRefundCount,customerProfile.balances[0].totalVerificationCount,customerProfile.balances[0].remainingCount],[20,5,5,10],"Project ledger shows gross bought/refunded, normal consumed, real remaining");
    caller={role:"hq",scopeMode:"STORE",storeId:1,staffId:1};
    const analytics=await face.getStoreBusinessAnalytics(range);
    eq(counts(analytics.totals),[20,5,4,5],"Store period totals match HQ for the same facts");
    caller={role:"teacher",teacherId:"1",staffId:11};
    const teacher=await face.getTeacherWorkspace({...range,recordType:"VERIFICATION",page:1,pageSize:10,includeOverview:true},caller);
    eq(counts(teacher.summary.totals),[20,5,4,5],"Teacher home includes store-selected attribution and own normal/experience");
    eq(teacher.page.records.map(r=>r.unitCount).sort(),[2,3],"Teacher normal detail includes supplement only once, excludes experience");
    const teacherCustomers=await face.getTeacherBusinessCustomers({customerPageSize:10});
    eq([teacherCustomers.active.records[0].rechargeCount,teacherCustomers.active.records[0].verificationCount],[20,5],"Teacher customer list agrees with normal/gross business totals");
    for(const [type,units] of [["RECHARGE",20],["REFUND",5],["EXPERIENCE",4]]){
      const detail=await face.getTeacherWorkspace({...range,recordType:type,page:1,pageSize:10},caller);
      eq(detail.page.records.reduce((n,r)=>n+r.unitCount,0),units,`Teacher ${type} detail matches overview`);
    }
    await recharge(3,"REFUND",2); await review("RECHARGE",3,"REJECTED");
    await expectedTotals([20,5,4,5]); eq(await balance(),10,"Rejected refund is excluded from all balances and totals");
    await verification(4,"SUPPLEMENT",11,"PENDING");
    await rejects(()=>review("VERIFICATION",4),/insufficient purchased units/);
    eq(await scalar("SELECT record_status FROM verification_records WHERE id=4"),"PENDING","Failed supplement approval rolls back decision");
    eq(await balance(),10,"Failed approval cannot partially consume balance"); await expectedTotals([20,5,4,5]);
    await review("VERIFICATION",4,"REJECTED");
    await rejects(()=>verification(5,"NORMAL",11),/insufficient purchased units/);
    eq(Number(await scalar("SELECT count(*) FROM verification_records WHERE id=5")),0,"Insufficient normal verification leaves no order");
    await rejects(()=>db.query("UPDATE recharge_records SET unit_count=21 WHERE id=1"),/immutable/);
    await rejects(()=>db.query("UPDATE verification_records SET unit_count=4 WHERE id=2"),/immutable/);
    await rejects(()=>recharge(8,"NEW",0),/check constraint/);
    await rejects(()=>recharge(8,"NEW",1000),/check constraint/);
    // Review in November must appear under its October submission date. All
    // timestamps use explicit Shanghai boundaries, even with a different DB TZ.
    await recharge(5,"NEW",7,"PENDING",{at:"2026-10-31T15:59:59.999999Z",store:2,teacher:2,customer:2,submitter:3});
    await review("RECHARGE",5);
    eq(counts((await hq.getHqDashboardOverview({startDate:"2026-10-31",endDate:"2026-10-31"})).totals),[7,0,0,0],"Shanghai end boundary includes final microsecond, not next midnight");
    eq(counts((await hq.getHqDashboardOverview({startDate:"2026-11-01",endDate:"2026-11-01"})).totals),[20,5,4,5],"Shanghai midnight belongs to next day and uses submission time");
    await db.exec("UPDATE customers SET customer_status='ARCHIVED' WHERE id=1; UPDATE teachers SET teacher_status='ARCHIVED' WHERE id IN (1,3); UPDATE stores SET store_status='ARCHIVED' WHERE id IN (1,3); UPDATE products SET product_status='ARCHIVED' WHERE id=1;");
    await expectedTotals([27,5,4,5]);
    caller={role:"hq",scopeMode:"STORE",storeId:1,staffId:1};
    const archivedStore=await face.getStoreDashboard({customerPageSize:10,archivedCustomerPage:99});
    eq(Number(archivedStore.store.archived_customers[0].total_recharge_count),20,"Archived customer keeps gross recharge on store home");
    eq(archivedStore.store.archived_customer_page,1,"Stale archived-customer page clamps to available data");
    const archivedTeacher=await face.getTeacherWorkspace({...range,recordType:"VERIFICATION",page:1,pageSize:10,includeOverview:true},{role:"teacher",teacherId:"1",staffId:11});
    eq(counts(archivedTeacher.summary.totals),[20,5,4,5],"Archived project and teacher retain authorized historical summary");
    // Simulate older approved facts with untrusted attribution. They still
    // belong in global/store/project totals and the unassigned teacher bucket.
    await recharge(6,"NEW",8,"PENDING",{teacher:2,submitter:11}); await review("RECHARGE",6);
    await recharge(7,"NEW",9,"PENDING",{teacher:2,submitter:1}); await review("RECHARGE",7);
    await verification(6,"EXPERIENCE",2,"APPROVED",{teacher:2,submitter:2});
    await expectedTotals([44,5,6,5]);
    for(const dimension of ["store","teacher"]){
      const result=(await hq.getHqDashboardRanking(range,{dimension,rankingMetric:"recharge",pageSize:500})).ranking;
      eq(result.rows.reduce((sum,row)=>sum+row.recharge,0),44,`${dimension} ranking reconciles with total, including unassigned`);
      eq(result.rows.reduce((sum,row)=>sum+row.experience,0),6,`${dimension} ranking preserves historical experience facts`);
      eq(result.rows.some(r=>r.entityId==="3"),false,`Archived zero-business ${dimension} does not become a ranking row`);
      if(dimension==="teacher")eq(counts(result.rows.find(row=>row.entityId==="0")),[17,0,2,0],"Untrusted teacher history is visible only in unassigned bucket");
    }
    caller={role:"hq",scopeMode:"STORE",storeId:1,staffId:1};
    const scoped=await face.getStoreBusinessAnalytics(range);
    eq(counts(scoped.totals),[37,5,6,5],"Store scope excludes cross-store facts without depending on customer origin");
    eq(scoped.dimensions.recharge.teachers.reduce((n,row)=>n+row.value,0),37,"Store teacher dimension and unassigned reconcile with store total");
    // Gift quantities and later product categories are independent of project
    // units. Names remain available after category archival.
    await db.exec(`INSERT INTO retail_products VALUES(1,'QA-RP-1','合成产品一','ARCHIVED'),(2,'QA-RP-2','未来产品类目','ACTIVE');
      INSERT INTO recharge_product_gifts VALUES(1,1,1,'合成产品一','QA-RP-1',99,1,1,1,1),(2,1,2,'未来产品类目','QA-RP-2',3,2,1,1,1);
      INSERT INTO retail_product_purchase_records(id,customer_id,teacher_id,store_id,retail_product_id,unit_count,record_status,purchase_code,product_name_snapshot,submitted_at,submitted_by_account_id)
        VALUES(1,1,1,1,1,7,'APPROVED','PP20261101000001','合成产品一','2026-11-01T01:00:00Z',2),
              (2,1,1,1,2,5,'PENDING','PP20261101000002','未来产品类目','2026-11-01T01:00:00Z',2);`);
    caller={role:"hq",scopeMode:"ALL",staffId:1};
    const productsProfile=await face.getCustomerProfile({customerCode:"QA-C-1",historyLimit:20});
    eq(productsProfile.retailProductSummary.map(row=>[row.productName,row.purchasedCount,row.giftedCount]).sort(),[["合成产品一",7,99],["未来产品类目",0,3]].sort(),"Customer product summary supports archived/new categories and excludes pending purchases");
    await expectedTotals([44,5,6,5]);
    const crossStore=await face.queryStoreBusinessRecords({recordType:"RECHARGE",page:1,pageSize:10,rechargeType:"NEW",statusCategory:"APPROVED",...range});
    eq(crossStore.records.reduce((n,row)=>n+row.unitCount,0),44,"Business search approved recharge reconciles with dashboard");
    const normalQuery=await face.queryStoreBusinessRecords({recordType:"VERIFICATION",page:1,pageSize:10,verificationType:"NORMAL",statusCategory:"APPROVED",...range});
    eq(normalQuery.records.reduce((n,row)=>n+row.unitCount,0),5,"Normal query includes approved supplements once, excludes experience and rejected");
    caller={role:"hq",scopeMode:"STORE",storeId:2,staffId:1};
    const store2query=await face.queryStoreBusinessRecords({recordType:"RECHARGE",page:99,pageSize:10,rechargeType:"NEW",statusCategory:"APPROVED",...range});
    eq(store2query.records.map(row=>row.storeId),["2"],"Stale business page clamps within store scope");
    // More than one page, identical timestamps, and changing names/statuses must
    // not multiply facts. Collect all bounded ranking pages as export does.
    for(let i=1;i<=25;i++){ await recharge(100+i,"NEW",i,"PENDING",{teacher:i,submitter:2}); await review("RECHARGE",100+i); }
    const seen=new Set(),exported=[];
    for(let page=1;page<=3;page++){
      const result=(await hq.getHqDashboardRanking(range,{dimension:"teacher",rankingMetric:"recharge",pageNumber:page,pageSize:10})).ranking;
      for(const row of result.rows){assert(!seen.has(row.entityId),"No teacher appears on two pages");checks++;seen.add(row.entityId);exported.push(row);}
      eq(result.rankingTotal,369,"Every page reports full scoped metric total, not page subtotal");
    }
    eq(exported.length,26,"Every teacher plus one unassigned bucket is exported once");
    eq(exported.reduce((n,row)=>n+row.recharge,0),369,"Full export matches independent expected ledger total");
    const lastPage=(await hq.getHqDashboardRanking(range,{dimension:"teacher",rankingMetric:"recharge",pageNumber:99,pageSize:10})).ranking;
    eq([lastPage.pageNumber,lastPage.rows.length],[3,6],"Out-of-range ranking clamps to final partial page");
    const beforeRename=counts(await totals());
    await db.exec("UPDATE teachers SET teacher_name='同名老师'; UPDATE stores SET store_name='同名门店'; UPDATE products SET product_name='同名项目';");
    eq(counts(await totals()),beforeRename,"Identical names and archived masters never duplicate/drop statistical facts");
    const filtered=(await hq.getHqDashboardRanking(range,{dimension:"teacher",productId:"2",rankingMetric:"recharge",pageSize:500})).ranking;
    eq(filtered.rankingTotal,0,"Project filter does not leak units from other projects");
    await rejects(()=>hq.getHqDashboardRanking(range,{dimension:"teacher",rankingMetric:"recharge;DROP TABLE customers"}),/无效/);
    eq(Number(await scalar("SELECT count(*) FROM customers")),2,"Rejected filter input cannot alter data");
    // Every customer-history tab uses independent server-side numbered pages,
    // including pending/rejected audit history. Ten rows replace the last page;
    // a count and its page are from one PostgreSQL statement.
    for(let i=0;i<21;i++){
      await recharge(200+i,"NEW",1);
      await recharge(300+i,"REFUND",1);
      await verification(1000+i,"SUPPLEMENT",1,"PENDING");
      await verification(2000+i,"EXPERIENCE",1);
    }
    await db.exec(`INSERT INTO retail_product_purchase_records(id,customer_id,teacher_id,store_id,retail_product_id,unit_count,record_status,purchase_code,submitted_at)
      SELECT 100+n,1,1,1,1,1,'PENDING','PP-QA-'||n,'2026-11-01T01:00:00Z' FROM generate_series(1,21)n`);
    caller={role:"hq",scopeMode:"ALL",staffId:1};
    const fields={RECHARGE:"recharges",REFUND:"refunds",VERIFICATION:"verifications",EXPERIENCE:"experiences",PRODUCT_PURCHASE:"productPurchases"};
    const initial=await face.getCustomerProfile({customerCode:"QA-C-1",historyPage:1,historyPageSize:10});
    for(const [type,field] of Object.entries(fields)){
      const table=type==="PRODUCT_PURCHASE"?"retail_product_purchase_records":["RECHARGE","REFUND"].includes(type)?"recharge_records":"verification_records";
      const predicate={RECHARGE:"recharge_type='NEW'",REFUND:"recharge_type='REFUND'",VERIFICATION:"verification_type<>'EXPERIENCE'",EXPERIENCE:"verification_type='EXPERIENCE'",PRODUCT_PURCHASE:"TRUE"}[type];
      const expected=(await db.query(`SELECT id FROM ${table} WHERE customer_id=1 AND ${predicate} ORDER BY submitted_at DESC,id DESC`)).rows.map(r=>String(r.id));
      eq(initial[field].length,10,`${type} first page is exactly ten rows`);
      eq(initial.history[field].total,expected.length,`${type} count covers all audit states for the selected customer`);
      for(const page of [1,2,99]){
        const result=await face.getCustomerProfile({customerCode:"QA-C-1",historyType:type,historyPage:page,historyPageSize:10});
        const effective=Math.min(page,Math.ceil(expected.length/10));
        eq(result[field].map(r=>r.id),expected.slice((effective-1)*10,effective*10),`${type} page ${page} has stable IDs and no cross-type/cross-customer leakage`);
        eq([result.history[field].pageNumber,result.history[field].totalPages,result.history[field].pageSize],[effective,Math.ceil(expected.length/10),10],`${type} page metadata clamps safely and preserves fixed size`);
      }
    }
    await rejects(()=>face.getCustomerProfile({customerCode:"QA-C-1",historyPage:1,historyPageSize:20}),/固定为 10/);
    await rejects(()=>face.getCustomerProfile({customerCode:"QA-C-1",historyPage:0.5,historyPageSize:10}),/页码/);
    await rejects(()=>face.getCustomerProfile({customerCode:"QA-C-1",historyType:"RECHARGE",historyPage:1,cursorSubmittedAt:"2026-11-01T00:00:00Z",cursorId:"1"}),/不能同时提交游标/);
    const legacy=await face.getCustomerProfile({customerCode:"QA-C-1",historyType:"RECHARGE",historyLimit:20});
    eq(legacy.recharges.length,20,"Old clients retain their cursor contract during backend-first rollout");
    caller={role:"store",scopeMode:"STORE",storeId:2,staffId:3};
    await rejects(()=>face.getCustomerProfile({customerCode:"QA-C-1",historyType:"RECHARGE",historyPage:1}),/有权查看/);
    // Exercise the complete new migration on legacy stages, not just a copied
    // CASE expression. Keep all balance/ledger bytes unchanged across backfill.
    await db.exec(`INSERT INTO customers(id,customer_code,customer_name,created_store_id,created_by_account_id)
      SELECT n,'QA-C-'||n,'阶段样例'||n,1,2 FROM generate_series(3,7)n;`);
    await recharge(9001,"NEW",6,"PENDING",{customer:3}); await review("RECHARGE",9001);
    await verification(9001,"EXPERIENCE",2,"APPROVED",{customer:3});
    await recharge(9002,"REFUND",6,"PENDING",{customer:3}); await review("RECHARGE",9002);
    eq(await scalar("SELECT customer_process_status FROM customers WHERE id=3"),"INFORMATION_ONLY","Legacy full refund demonstrates the historical-stage inconsistency");
    await recharge(9003,"NEW",4,"PENDING",{customer:4}); await review("RECHARGE",9003);
    await verification(9002,"SUPPLEMENT",2,"PENDING",{customer:4}); await review("VERIFICATION",9002);
    await recharge(9004,"REFUND",2,"PENDING",{customer:4}); await review("RECHARGE",9004);
    await verification(9003,"EXPERIENCE",1,"APPROVED",{customer:5});
    await recharge(9005,"NEW",3,"PENDING",{customer:6}); await review("RECHARGE",9005,"REJECTED");
    await recharge(9006,"NEW",3,"PENDING",{customer:7}); await review("RECHARGE",9006);
    await verification(9004,"SUPPLEMENT",1,"PENDING",{customer:7});
    const immutableSnapshot=async()=>{
      const result={};
      for(const table of ["staff_accounts","teachers","stores","products","recharge_records","verification_records","customer_product_balances","recharge_product_gifts","retail_product_purchase_records"])
        result[table]=(await db.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
      result.customers=(await db.query("SELECT to_jsonb(c)-'customer_process_status' AS value FROM customers c ORDER BY id")).rows;
      return result;
    };
    const beforeStageMigration=await immutableSnapshot();
    await db.exec(read("database/migrations/092_historical_customer_business_stage.sql"));
    eq(await immutableSnapshot(),beforeStageMigration,"Stage migration changes no orders, balances, totals, times, permissions or customer fields except stage");
    const stage=id=>scalar(`SELECT customer_process_status FROM customers WHERE id=${id}`);
    eq(await stage(3),"RECHARGED_NO_CONSUMPTION","Full refund retains historical recharge; experience is not normal consumption");
    eq(await stage(4),"RECHARGED_WITH_CONSUMPTION","Approved supplement is historical normal consumption even after refund of remaining units");
    eq(await stage(5),"INFORMATION_ONLY","Experience-only customer has no historical recharge");
    eq(await stage(6),"INFORMATION_ONLY","Rejected recharge is not historical effective business");
    eq(await stage(7),"RECHARGED_NO_CONSUMPTION","Pending supplement does not change historical business stage");
    const stageVerification=await db.exec(read("database/cloudbase-console/092-readonly-verify.sql"));
    eq(stageVerification.map(r=>r.rows[0].status),["READY","READY"],"Independent migration verification checks are READY");
    caller={role:"hq",scopeMode:"ALL",staffId:1};
    const historicalQuery=await face.queryStoreCustomers({processStatus:"RECHARGED_NO_CONSUMPTION",limit:10});
    // queryStoreCustomers receives the same persisted stage used by store home
    // and profile; filtering and group counts must not recompute a net stage.
    eq((await face.getCustomerProfile({customerCode:"QA-C-3",historyPage:1})).customer.customerProcessStatus,"RECHARGED_NO_CONSUMPTION","Customer profile returns canonical historical stage");
    eq(historicalQuery.customers.find(c=>c.customerCode==="QA-C-3").customerProcessStatus,"RECHARGED_NO_CONSUMPTION","Customer list uses canonical historical stage");
    await recharge(9007,"NEW",2,"PENDING",{customer:3}); await review("RECHARGE",9007);
    await recharge(9008,"REFUND",2,"PENDING",{customer:3}); await review("RECHARGE",9008);
    eq(await stage(3),"RECHARGED_NO_CONSUMPTION","Future refreshes preserve historical stage after another full refund");
    await review("VERIFICATION",9004);
    eq(await stage(7),"RECHARGED_WITH_CONSUMPTION","Future supplement approval updates stage through the original trigger");
    await db.exec(read("database/migrations/092_historical_customer_business_stage.sql"));
    eq(await stage(3),"RECHARGED_NO_CONSUMPTION","Reapplying stage migration is idempotent");
    console.log(JSON.stringify({postgres:"isolated PGlite",checks,executedReadQueries,productionWrites:0},null,2));
  } finally { await db.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
