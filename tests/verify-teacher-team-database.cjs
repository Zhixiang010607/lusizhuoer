"use strict";

// Isolated in-memory PostgreSQL only. Never connects to CloudBase or accepts a
// database URL. Supply a locally installed @electric-sql/pglite package path.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  if (!process.argv[2]) throw new Error("Supply the local PGlite package path; no production database is supported");
  const { PGlite } = require(path.resolve(process.argv[2]));
  const db = new PGlite();
  let passed = 0;
  const check = (value, message) => { assert.ok(value, message); passed += 1; };
  const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
  const appoint = (teacher, enabled = true, actor = "qa-hq") => scalar("SELECT public.set_teacher_team_leader_v91($1,$2,$3)", [actor, teacher, enabled]);
  const assign = (leader, member, enabled = true, actor = "qa-hq") => scalar("SELECT public.set_teacher_team_member_v91($1,$2,$3,$4)", [actor, leader, member, enabled]);
  const leader = (uid) => scalar("SELECT public.is_teacher_team_leader_v91($1)", [uid]);
  const member = (uid, teacher) => scalar("SELECT public.can_read_teacher_team_member_v91($1,$2)", [uid, teacher]);
  async function rejects(run, marker) {
    await assert.rejects(run, (error) => String(error.message).includes(marker));
    passed += 1;
  }

  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.staff_accounts(id BIGINT PRIMARY KEY,auth_uid TEXT UNIQUE NOT NULL,role_code TEXT NOT NULL,account_status TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '');
      CREATE TABLE public.teachers(id BIGINT PRIMARY KEY,staff_account_id BIGINT UNIQUE NOT NULL REFERENCES public.staff_accounts(id),teacher_status TEXT NOT NULL,teacher_name TEXT NOT NULL,teacher_code TEXT NOT NULL DEFAULT '');
      INSERT INTO public.staff_accounts(id,auth_uid,role_code,account_status) VALUES (1,'qa-hq','hq','ACTIVE'),(2,'qa-store','store','ACTIVE');
      INSERT INTO public.staff_accounts(id,auth_uid,role_code,account_status) SELECT n+10,'qa-teacher-'||n,'teacher','ACTIVE' FROM generate_series(1,8) n;
      INSERT INTO public.teachers(id,staff_account_id,teacher_status,teacher_name) SELECT n,n+10,'ACTIVE','示例老师'||n FROM generate_series(1,8) n;
    `);
    const beforeAccounts = await scalar("SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.staff_accounts a");
    const beforeTeachers = await scalar("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.teachers t");
    const migrationSql = fs.readFileSync(path.resolve(__dirname, "../database/migrations/091_teacher_team_leadership.sql"), "utf8");
    const consoleSql = fs.readFileSync(path.resolve(__dirname, "../database/cloudbase-console/091-01-teacher-team-leadership.sql"), "utf8");
    check(consoleSql === migrationSql, "standalone console SQL must match the tested migration byte for byte");
    await db.exec(migrationSql);
    const readinessSql = fs.readFileSync(path.resolve(__dirname, "../database/cloudbase-console/091-readonly-verify.sql"), "utf8");
    const readiness = (await db.query(readinessSql)).rows;
    check(readiness.length === 9, "standalone read-only acceptance must run all nine checks");
    for (const row of readiness) check(row.status === "READY", `standalone acceptance: ${row.check_name}`);
    check(await scalar("SELECT count(*)::int FROM public.teacher_team_leaders") === 0, "migration must not appoint production-like accounts automatically");
    check(JSON.stringify(await scalar("SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.staff_accounts a")) === JSON.stringify(beforeAccounts), "migration must preserve accounts");
    check(JSON.stringify(await scalar("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.teachers t")) === JSON.stringify(beforeTeachers), "migration must preserve teachers");

    await rejects(() => appoint(1, true, "qa-teacher-1"), "TEAM_ONLY_HQ");
    await rejects(() => appoint(1, true, "qa-store"), "TEAM_ONLY_HQ");
    await rejects(() => appoint(1, true, "qa-hq' OR 1=1 --"), "TEAM_ONLY_HQ");
    check((await appoint(1)).isTeamLeader === true, "HQ appoints teacher");
    check((await appoint(1)).idempotentReplay === true, "duplicate appointment is idempotent");
    check(await scalar("SELECT count(*)::int FROM public.teacher_team_events") === 1, "duplicate appointment has no duplicate audit");
    await appoint(2);
    await assign(1, 3);
    check(await leader("qa-teacher-1") === true, "active teacher has leader capability");
    check(await member("qa-teacher-1", 3) === true, "assigned member may be read");
    check(await member("qa-teacher-1", 1) === false, "leader is not implicitly their own member");
    check(await member("qa-teacher-2", 3) === false, "other leader cannot read member");
    check(await member("qa-teacher-3", 1) === false, "ordinary teacher cannot read leader");
    check(await member("qa-store", 3) === false, "store cannot read group members");
    await rejects(() => assign(2, 3), "TEAM_REMOVE_BEFORE_TRANSFER");
    await rejects(() => appoint(3), "TEAM_REMOVE_BEFORE_PROMOTION");
    await rejects(() => assign(1, 2), "TEAM_MEMBER_IS_LEADER");
    await rejects(() => assign(1, 1), "TEAM_INVALID_MEMBER");
    await rejects(() => assign(1, 999), "TEAM_TEACHER_NOT_ACTIVE");
    await rejects(() => assign(1, 4, true, "qa-teacher-1"), "TEAM_ONLY_HQ");
    await assign(1, 4);
    const transactionAuditCount = await scalar("SELECT count(*)::int FROM public.teacher_team_events");
    await db.exec("BEGIN");
    const rolledBackRevoke = await appoint(1, false);
    check(Number(rolledBackRevoke.releasedCount) === 2, "revocation releases all members within its transaction");
    check(await member("qa-teacher-1", 3) === false, "revoked scope is closed inside the transaction");
    await db.exec("ROLLBACK");
    check(await leader("qa-teacher-1") === true, "rollback restores prior leader capability");
    check(await scalar("SELECT count(*)::int FROM public.teacher_team_members WHERE leader_teacher_id=1") === 2, "rollback restores every membership");
    check(await scalar("SELECT count(*)::int FROM public.teacher_team_events") === transactionAuditCount, "rollback leaves no partial release audit");
    await db.exec(`CREATE FUNCTION public.qa_fail_team_revoke_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='REVOKE' THEN RAISE EXCEPTION 'QA_REVOKE_AUDIT_FAILED'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER qa_fail_team_revoke_event BEFORE INSERT ON public.teacher_team_events
      FOR EACH ROW EXECUTE FUNCTION public.qa_fail_team_revoke_event();`);
    await rejects(() => appoint(1, false), "QA_REVOKE_AUDIT_FAILED");
    check(await leader("qa-teacher-1") === true, "audit failure does not partially revoke leadership");
    check(await scalar("SELECT count(*)::int FROM public.teacher_team_members WHERE leader_teacher_id=1") === 2, "audit failure does not release any member");
    check(await scalar("SELECT count(*)::int FROM public.teacher_team_events") === transactionAuditCount, "audit failure rolls back auto-release events");
    await db.exec("DROP TRIGGER qa_fail_team_revoke_event ON public.teacher_team_events; DROP FUNCTION public.qa_fail_team_revoke_event()");
    const revoked = await appoint(1, false);
    check(Number(revoked.releasedCount) === 2, "revocation releases all members atomically");
    check(await scalar("SELECT count(*)::int FROM public.teacher_team_members WHERE leader_teacher_id=1") === 0, "revocation leaves no hidden member bindings");
    check(await member("qa-teacher-1", 3) === false, "revoked leader immediately loses scope");
    check(await leader("qa-teacher-1") === false, "revoked teacher loses leader capability");
    check(await scalar("SELECT count(*)::int FROM public.teacher_team_events WHERE event_type='AUTO_RELEASE'") === 2, "each released membership retains audit");
    await assign(2, 3);
    check(await member("qa-teacher-2", 3) === true, "released member can join a different leader");
    await appoint(1);
    check(await scalar("SELECT count(*)::int FROM public.teacher_team_members WHERE leader_teacher_id=1") === 0, "reappointment does not restore old members");
    check(await member("qa-teacher-1", 3) === false, "reappointment does not restore old access");
    await assign(2, 3, false);
    await appoint(3);
    check(await leader("qa-teacher-3") === true, "former member can be promoted after removal");

    const race = await Promise.allSettled([assign(1, 5), assign(2, 5)]);
    check(race.filter((x) => x.status === "fulfilled").length === 1, "competing assignments only allow one owner");
    check(await scalar("SELECT count(*)::int FROM public.teacher_team_members WHERE member_teacher_id=5") === 1, "global unique membership persists");
    const auditBefore = await scalar("SELECT count(*)::int FROM public.teacher_team_events");
    await rejects(() => db.query("UPDATE public.teacher_team_events SET event_type='REMOVE'"), "TEAM_AUDIT_IMMUTABLE");
    await rejects(() => db.query("DELETE FROM public.teacher_team_events"), "TEAM_AUDIT_IMMUTABLE");
    check(await scalar("SELECT count(*)::int FROM public.teacher_team_events") === auditBefore, "failed audit mutations preserve history");

    await db.exec("UPDATE public.staff_accounts SET account_status='ARCHIVED' WHERE auth_uid='qa-teacher-1'");
    check(await leader("qa-teacher-1") === false, "archived leader cannot use group capability");
    check(await member("qa-teacher-1", 5) === false, "archived leader cannot read assigned history");
    await appoint(1, false);
    check(await scalar("SELECT count(*)::int FROM public.teacher_team_members WHERE leader_teacher_id=1") === 0, "HQ can revoke archived leader and release members");

    const { createTeacherTeams } = require("../cloudfunctions/staffAccount/teacher-team");
    const teams = createTeacherTeams({
      executeSql: async (sql) => (await db.query(sql)).rows,
      sqlText: (value) => "'" + String(value ?? "").replace(/'/g, "''") + "'",
      numericId: (value) => { if (!/^[1-9]\d{0,17}$/.test(String(value))) throw Object.assign(new Error("Invalid ID"), { code: "BAD_REQUEST" }); return String(value); },
      fail: (message, code) => { throw Object.assign(new Error(message), { code }); }
    });
    const hqCaller = { uid: "qa-hq", profile: { role: "hq", staffId: "1" } };
    const leadCaller = { uid: "qa-teacher-2", profile: { role: "teacher", teacherId: "2", staffId: "12" } };
    const ordinaryCaller = { uid: "qa-teacher-6", profile: { role: "teacher", teacherId: "6", staffId: "16", isTeamLeader: true } };
    await assign(2, 6);
    await assign(3, 7);
    check((await teams.handle("getTeamAccess", leadCaller)).isTeamLeader === true, "service capability comes from database");
    check((await teams.handle("getTeamAccess", ordinaryCaller)).isTeamLeader === false, "cached client leader flag cannot confer capability");
    const own = await teams.handle("getMyTeacherTeam", leadCaller, { keyword: "老师6", leaderId: "3", role: "hq" });
    check(own.members.records.length === 1 && own.members.records[0].teacherId === "6", "forged leader/role filters cannot expand group list");
    check(own.members.pageSize === 10, "member pages are bounded to ten rows");
    const foreign = await teams.handle("getMyTeacherTeam", leadCaller, { keyword: "老师7" });
    check(foreign.members.records.length === 0 && foreign.members.total === 0, "search and counts do not expose another group");
    await assert.rejects(() => teams.handle("getTeamTeacherProfile", leadCaller, { teacherId: "7" }), (error) => error.code === "FORBIDDEN"); passed += 1;
    await assert.rejects(() => teams.handle("getMyTeacherTeam", ordinaryCaller, { role: "hq" }), (error) => error.code === "FORBIDDEN"); passed += 1;
    await assert.rejects(() => teams.handle("setTeacherTeamMember", leadCaller, { teacherId: "2", memberTeacherId: "4", assigned: true, actorUid: "qa-hq", role: "hq" }), (error) => error.code === "FORBIDDEN"); passed += 1;
    const candidatePage = await teams.handle("listTeacherTeamCandidates", hqCaller, { teacherId: "2", keyword: "老师" });
    check(candidatePage.candidates.records.every((row) => !["2", "3"].includes(row.teacherId)), "HQ candidates exclude all current leaders and self");
    check(candidatePage.candidates.records.find((row) => row.teacherId === "7").canAdd === false, "other group's ordinary teacher is not addable");
    const literal = await teams.handle("listTeacherTeamCandidates", hqCaller, { teacherId: "2", keyword: "%" });
    check(literal.candidates.total === 0, "wildcards in name search are literal");
    const spoofedHq = { uid: "qa-teacher-2", profile: { role: "hq" } };
    await assert.rejects(() => teams.handle("getTeacherTeam", spoofedHq, { teacherId: "3" }), (error) => error.code === "NOT_FOUND"); passed += 1;
    const assigned = await teams.handle("setTeacherTeamMember", hqCaller, { teacherId: "2", memberTeacherId: "4", assigned: true, actorUid: "qa-teacher-2" });
    check(assigned.assigned === true, "mutation uses authenticated caller rather than event actor");
    const details = await teams.handle("getTeacherTeam", hqCaller, { teacherId: "2" });
    check(details.teacher.isTeamLeader === true && details.members.total === 2, "HQ details reflect authoritative membership");
    const cancelled = await teams.handle("setTeacherTeamLeader", hqCaller, { teacherId: "2", enabled: false });
    check(cancelled.releasedCount === 2, "service revocation returns exact released count");
    await assert.rejects(() => teams.handle("getMyTeacherTeam", leadCaller), (error) => error.code === "FORBIDDEN"); passed += 1;
    await assert.rejects(() => teams.handle("getTeamTeacherProfile", leadCaller, { teacherId: "6" }), (error) => error.code === "FORBIDDEN"); passed += 1;

    await db.exec("SET ROLE anon");
    await rejects(() => db.query("SELECT * FROM public.teacher_team_members"), "permission denied");
    await rejects(() => leader("qa-teacher-2"), "permission denied");
    await rejects(() => appoint(8), "permission denied");
    await db.exec("RESET ROLE; SET ROLE authenticated");
    await rejects(() => db.query("SELECT * FROM public.teacher_team_leaders"), "permission denied");
    await rejects(() => assign(2, 8), "permission denied");
    await db.exec("RESET ROLE; SET ROLE service_role");
    await rejects(() => db.query("DELETE FROM public.teacher_team_members"), "permission denied");
    await rejects(() => appoint(8, true, "qa-teacher-2"), "TEAM_ONLY_HQ");
    check((await appoint(8)).isTeamLeader === true, "trusted service function still rechecks active HQ actor");
    await db.exec("RESET ROLE");
    const afterPromotion = await teams.handle("listTeacherTeamCandidates", hqCaller, { teacherId: "3" });
    check(afterPromotion.candidates.records.every((row) => row.teacherId !== "8"), "newly promoted leader immediately leaves ordinary-teacher candidates");

    // Use the production attribution SQL generator, not a permissive fake.
    const vm = require("node:vm");
    const faceSource = fs.readFileSync(path.resolve(__dirname, "../cloudfunctions/faceRecognition/index.js"), "utf8");
    const attributionStart = faceSource.indexOf("function teacherBusinessAttributionSourceCondition(");
    const attributionEnd = faceSource.indexOf("\nfunction trustedBusinessTeacherIdSql(", attributionStart);
    const attribution = vm.runInNewContext("(" + faceSource.slice(attributionStart, attributionEnd) + ")");
    await db.exec(`
      CREATE TABLE public.customers(id BIGINT PRIMARY KEY,created_by_account_id BIGINT);
      CREATE TABLE public.verification_records(id BIGINT PRIMARY KEY,customer_id BIGINT,teacher_id BIGINT,submitted_by_account_id BIGINT,verification_type TEXT,record_status TEXT);
      CREATE TABLE public.recharge_records(id BIGINT PRIMARY KEY,customer_id BIGINT,teacher_id BIGINT,submitted_by_account_id BIGINT,recharge_type TEXT,record_status TEXT);
      CREATE TABLE public.retail_product_purchase_records(id BIGINT PRIMARY KEY,customer_id BIGINT,teacher_id BIGINT,submitted_by_account_id BIGINT,record_status TEXT);
      INSERT INTO public.customers VALUES (1,17),(2,2),(3,2),(4,2),(5,2),(6,2),(7,2);
      INSERT INTO public.verification_records VALUES
        (1,2,7,2,'NORMAL','APPROVED'),(2,3,6,2,'NORMAL','APPROVED'),
        (3,4,7,16,'NORMAL','APPROVED'),(4,5,7,2,'EXPERIENCE','APPROVED'),
        (5,6,7,2,'SUPPLEMENT','APPROVED'),(6,7,7,2,'NORMAL','PENDING'),
        (7,2,6,2,'NORMAL','APPROVED');
    `);
    let authenticatedUid = "qa-teacher-3";
    const { createTeacherTeamReads } = require("../cloudfunctions/faceRecognition/teacher-team");
    const reads = createTeacherTeamReads({
      executeSql: async (sql) => (await db.query(sql)).rows,
      sqlText: (value) => "'" + String(value ?? "").replace(/'/g, "''") + "'",
      fail: (message, code) => { throw Object.assign(new Error(message), { code }); },
      positiveDatabaseId: (value) => { if (!/^[1-9]\d{0,17}$/.test(String(value))) throw Object.assign(new Error("Invalid ID"), { code: "BAD_REQUEST" }); return String(value); },
      teacherBusinessAttributionSourceCondition: attribution,
      activeTeacherCaller: async () => {
        const found = (await db.query("SELECT a.id,t.id AS teacher_id FROM public.staff_accounts a JOIN public.teachers t ON t.staff_account_id=a.id WHERE a.auth_uid=$1 AND a.role_code='teacher' AND a.account_status='ACTIVE' AND t.teacher_status='ACTIVE'", [authenticatedUid])).rows[0];
        if (!found) throw Object.assign(new Error("Only active teacher"), { code: "FORBIDDEN" });
        return { uid: authenticatedUid, role: "teacher", teacherId: String(found.teacher_id), staffId: Number(found.id) };
      }
    });
    const groupScope = await reads.context({ role: "hq", uid: "qa-hq", leaderId: "2" });
    check(groupScope.scopeMode === "TEAM" && groupScope.role === "teacher", "team reader never becomes HQ from event identity");
    const scopedCustomers = await db.query(`SELECT c.id::text FROM public.customers c WHERE ${groupScope.teamCustomerScope} ORDER BY c.id`);
    check(JSON.stringify(scopedCustomers.rows.map((row) => row.id)) === JSON.stringify(["1", "2", "6"]), "operational scope includes only member-created or trusted approved member customers");
    const scopedEvents = await db.query(`SELECT v.id::text FROM public.verification_records v WHERE v.record_status='APPROVED' AND ${groupScope.teamVerificationScope} ORDER BY v.id`);
    check(JSON.stringify(scopedEvents.rows.map((row) => row.id)) === JSON.stringify(["1", "5"]), "activity baseline excludes other teachers, pending records, wrong submitter and store experience");
    await assert.rejects(() => reads.context({ teacherId: "6" }), (error) => error.code === "FORBIDDEN"); passed += 1;
    await assert.rejects(() => reads.member("6"), (error) => error.code === "FORBIDDEN"); passed += 1;
    check((await reads.member("7")).teacherId === "7", "group workspace target is pinned to an actual assigned member");
    // Execute the production HQ CTE/projections through the new scoped reader.
    // Outside-group facts, zero-business masters and an old date must not leak.
    await db.exec(`
      ALTER TABLE public.verification_records ADD COLUMN store_id BIGINT DEFAULT 1,ADD COLUMN product_id BIGINT DEFAULT 1,
        ADD COLUMN unit_count BIGINT DEFAULT 1,ADD COLUMN submitted_at TIMESTAMPTZ DEFAULT '2026-11-06T01:00:00Z';
      ALTER TABLE public.recharge_records ADD COLUMN store_id BIGINT DEFAULT 1,ADD COLUMN product_id BIGINT DEFAULT 1,
        ADD COLUMN unit_count BIGINT DEFAULT 1,ADD COLUMN submitted_at TIMESTAMPTZ DEFAULT '2026-11-06T01:00:00Z';
      UPDATE public.verification_records SET submitted_at='2000-01-01T01:00:00Z' WHERE id=2;
      CREATE TABLE public.stores(id BIGINT PRIMARY KEY,store_code TEXT,store_name TEXT,store_status TEXT);
      INSERT INTO public.stores VALUES(1,'QA1','示例门店一','ACTIVE'),(2,'QA2','示例门店二','ACTIVE'),(3,'QA3','组外门店','ACTIVE');
      CREATE TABLE public.products(id BIGINT PRIMARY KEY,product_code TEXT,product_name TEXT,product_status TEXT DEFAULT 'ACTIVE');
      INSERT INTO public.products(id,product_code,product_name) VALUES(1,'QA1','示例项目一'),(2,'QA2','示例项目二'),(3,'QA3','示例未使用项目');
      INSERT INTO public.recharge_records(id,customer_id,teacher_id,submitted_by_account_id,recharge_type,record_status,store_id,product_id,unit_count) VALUES
        (101,1,7,2,'NEW','APPROVED',2,2,4),(102,1,6,2,'NEW','APPROVED',3,2,100),
        (103,1,7,16,'NEW','APPROVED',3,2,100),(104,1,7,2,'REFUND','APPROVED',2,2,1),(105,1,7,17,'NEW','APPROVED',1,1,2);
    `);
    const staffSource=fs.readFileSync(path.resolve(__dirname,"../cloudfunctions/staffAccount/index.js"),"utf8");
    const context=vm.createContext({Date,Set,Number,String,Math,Object,JSON,
      HQ_DASHBOARD_DEFAULT_PAGE_SIZE:100,HQ_DASHBOARD_MAX_PAGE_SIZE:500,HQ_DASHBOARD_MAX_PAGE_NUMBER:10000,
      sqlText:v=>"'"+String(v).replace(/'/g,"''")+"'",numericId:v=>String(v),
      fail:(message,code)=>{throw Object.assign(new Error(message),{code});}});
    vm.runInContext(staffSource.slice(staffSource.indexOf("function strictDashboardDate("),staffSource.indexOf("\nfunction asDatabaseError(")),context);
    vm.runInContext(staffSource.slice(staffSource.indexOf("function hqDashboardRow("),staffSource.indexOf("\nfunction hqDashboardRangeFromTotal(")),context);
    vm.runInContext(staffSource.slice(staffSource.indexOf("function hqDashboardRankingMetricColumn("),staffSource.indexOf("\nfunction hqDashboardRankingSql(")),context);
    const {createTeacherTeamDashboard}=require("../cloudfunctions/staffAccount/teacher-team-dashboard");
    const teamDashboard=createTeacherTeamDashboard({executeSql:async sql=>{try{return(await db.query(sql)).rows;}catch(error){console.error("Isolated dashboard SQL failed:",error.message);throw error;}},teams,
      dateRange:context.dashboardDateRange,readMode:context.dashboardReadMode,rankingRequest:context.dashboardRankingRequest,
      summaryRequest:context.dashboardProductSummaryRequest,dateSql:context.hqDashboardDateSql,eventsCte:context.hqBusinessEventsCte,
      projection:context.hqDashboardRankingProjection,metricColumn:context.hqDashboardRankingMetricColumn,mapRow:context.hqDashboardRow,version:"v99"});
    const dashboardCaller={uid:"qa-teacher-3",profile:{role:"teacher",teacherId:"3",staffId:"13"}};
    const overview=await teamDashboard.read(dashboardCaller,{allTime:true,role:"hq",leaderId:"2"});
    check(overview.totals.verification===2&&overview.totals.recharge===6&&overview.totals.refund===1&&overview.totals.experience===0,"dashboard uses trusted member facts including supplements, excluding wrong submitters");
    check(overview.range.startDate==="2026-11-06","all-time range never leaks an older outside-group event date");
    check(overview.totals.stores===2&&overview.totals.teachers===1,"population counts exclude unrelated masters");
    const ranking=await teamDashboard.read(dashboardCaller,{mode:"ranking",dimension:"teacher",rankingMetric:"recharge",pageNumber:99,pageSize:10,allTime:true});
    check(ranking.ranking.total===1&&ranking.ranking.pageNumber===1&&ranking.ranking.rows[0].entityId==="7","teacher ranking and stale-page clamp exclude all outside-group teachers");
    const storeRanking=await teamDashboard.read(dashboardCaller,{mode:"ranking",dimension:"store",rankingMetric:"recharge",pageSize:1,pageNumber:2,allTime:true});
    check(storeRanking.ranking.total===2&&storeRanking.ranking.totalPages===2&&storeRanking.ranking.rows.length===1,"store grouping pages only member business stores");
    const filtered=await teamDashboard.read(dashboardCaller,{mode:"ranking",dimension:"teacher",rankingMetric:"recharge",productId:"2",allTime:true});
    check(filtered.ranking.rows[0].recharge===4&&filtered.ranking.rows[0].verification===0,"project filter narrows member facts without widening group scope");
    const summary=await teamDashboard.read(dashboardCaller,{mode:"product-summary",pageSize:10,allTime:true});
    check(summary.productSummary.total===3&&summary.productSummary.rows.find(row=>row.entityId==="3").recharge===0,"project summary retains HQ zero-project presentation without outside-group totals");
    await db.exec("UPDATE public.products SET product_status='ARCHIVED' WHERE id=2");
    const catalog=await teamDashboard.read(dashboardCaller,{mode:"products"});
    check(catalog.products.find(row=>row.id==="2").product_status==="ARCHIVED","group overview can filter archived-project history using only shared master labels");
    await assert.rejects(()=>teamDashboard.read(ordinaryCaller,{allTime:true,role:"hq"}),e=>e.code==="FORBIDDEN");passed+=1;
    await assign(3,7,false);
    const removed=await teamDashboard.read(dashboardCaller,{mode:"ranking",dimension:"teacher",allTime:true});
    check(removed.ranking.total===0&&removed.ranking.rows.length===0,"removing a member immediately removes their ranking and counts");
    await assign(3,7);
    const financialBefore = await scalar("SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM public.verification_records v");
    await appoint(3, false);
    const staleCustomers = await db.query(`SELECT c.id FROM public.customers c WHERE ${groupScope.teamCustomerScope}`);
    check(staleCustomers.rows.length === 0, "even a prebuilt scope cannot read after revocation");
    await assert.rejects(() => reads.context(), (error) => error.code === "FORBIDDEN"); passed += 1;
    authenticatedUid = "qa-hq";
    await assert.rejects(() => reads.context(), (error) => error.code === "FORBIDDEN"); passed += 1;
    check(JSON.stringify(await scalar("SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM public.verification_records v")) === JSON.stringify(financialBefore), "group read scopes do not mutate financial facts");
    check(JSON.stringify(await scalar("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.teachers t")) === JSON.stringify(beforeTeachers), "group operations do not rewrite teacher masters");
    console.log(JSON.stringify({ isolatedPostgres: true, checks: passed, productionConnections: 0 }));
  } finally { await db.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
