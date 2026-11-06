"use strict";

// Read-only, UID-derived team scope. This module has no staff management or
// mutation entry points and never treats a teacher as a headquarters caller.
function createTeacherTeamReads({ executeSql, sqlText, fail, activeTeacherCaller, positiveDatabaseId, teacherBusinessAttributionSourceCondition }) {
  let verifiedSchema = false;
  const boolean = (value) => [true, "true", "t", 1, "1"].includes(value);
  async function available() {
    if (verifiedSchema) return true;
    const rows = await executeSql("SELECT TO_REGPROCEDURE('public.is_teacher_team_leader_v91(text)') IS NOT NULL AND TO_REGPROCEDURE('public.can_read_teacher_team_member_v91(text,bigint)') IS NOT NULL AS ready");
    verifiedSchema = boolean(rows?.[0]?.ready);
    return verifiedSchema;
  }
  function scope(uid, column) {
    if (!/^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/i.test(column)) throw new Error("Invalid internal team column");
    return `public.can_read_teacher_team_member_v91(${sqlText(uid)}, ${column})`;
  }
  function scopeId(uid, id) {
    return `public.can_read_teacher_team_member_v91(${sqlText(uid)}, ${positiveDatabaseId(id, "老师")}::bigint)`;
  }
  async function leader() {
    const caller = await activeTeacherCaller();
    if (!await available()) fail("小组长功能尚未启用，请联系总部完成更新。", "TEAM_SCHEMA_NOT_READY");
    const rows = await executeSql(`SELECT public.is_teacher_team_leader_v91(${sqlText(caller.uid)}) AS enabled`);
    if (!boolean(rows?.[0]?.enabled)) fail("当前没有组长查看权限，请返回个人工作台。", "FORBIDDEN");
    return caller;
  }
  async function member(id) {
    const caller = await leader();
    const teacherId = positiveDatabaseId(id, "老师");
    const rows = await executeSql(`SELECT ${scopeId(caller.uid, teacherId)} AS allowed`);
    if (!boolean(rows?.[0]?.allowed)) fail("该老师不在你当前的管理名单中。", "FORBIDDEN");
    return { caller, teacherId, predicate: scopeId(caller.uid, teacherId) };
  }
  function customerScope(caller, targetTeacherId = "", alias = "c") {
    if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error("Invalid internal customer alias");
    return `EXISTS (SELECT 1 FROM public.teachers team_member
      WHERE public.is_teacher_team_leader_v91(${sqlText(caller.uid)})
        AND (${scope(caller.uid, "team_member.id")}
          OR EXISTS (SELECT 1 FROM public.staff_accounts team_self
            WHERE team_self.id = team_member.staff_account_id
              AND team_self.auth_uid = ${sqlText(caller.uid)}
              AND team_self.role_code = 'teacher' AND team_self.account_status = 'ACTIVE'
              AND team_member.teacher_status = 'ACTIVE'))
        ${targetTeacherId ? `AND team_member.id = ${positiveDatabaseId(targetTeacherId, "老师")}::bigint` : ""}
        AND (${alias}.created_by_account_id = team_member.staff_account_id
          OR EXISTS (SELECT 1 FROM public.verification_records team_verification
            WHERE team_verification.customer_id = ${alias}.id AND team_verification.teacher_id = team_member.id
              AND ${teacherBusinessAttributionSourceCondition("team_verification", "VERIFICATION")}
              AND team_verification.record_status = 'APPROVED'
              AND team_verification.verification_type IN ('NORMAL','SUPPLEMENT','EXPERIENCE'))
          OR EXISTS (SELECT 1 FROM public.recharge_records team_recharge
            WHERE team_recharge.customer_id = ${alias}.id AND team_recharge.teacher_id = team_member.id
              AND ${teacherBusinessAttributionSourceCondition("team_recharge", "RECHARGE")}
              AND team_recharge.record_status = 'APPROVED' AND team_recharge.recharge_type IN ('NEW','REFUND'))
          OR EXISTS (SELECT 1 FROM public.retail_product_purchase_records team_purchase
            WHERE team_purchase.customer_id = ${alias}.id AND team_purchase.teacher_id = team_member.id
              AND team_purchase.submitted_by_account_id = team_member.staff_account_id
              AND team_purchase.record_status = 'APPROVED')))`;
  }
  async function context(event = {}) {
    const caller = await leader();
    const target = String(event.teacherId || "").trim();
    let teacherId = "";
    if (target && target.toUpperCase() !== "ALL") {
      teacherId = positiveDatabaseId(target, "老师");
      const rows = await executeSql(`SELECT ${scopeId(caller.uid, teacherId)} AS allowed`);
      if (!boolean(rows?.[0]?.allowed)) fail("所选老师不在你当前的管理名单中。", "FORBIDDEN");
    }
    const store = String(event.storeId || "").trim();
    const storeId = store && store.toUpperCase() !== "ALL" ? positiveDatabaseId(store, "门店") : null;
    return Object.freeze({ ...caller, role: "teacher", storeId, storeCode: "", storeName: "本组老师", scopeMode: "TEAM",
      teamCustomerScope: customerScope(caller, teacherId),
      // The customer set is scoped; its actual latest service is not limited
      // to one provider, otherwise a handover would produce false inactivity.
      teamVerificationScope: "TRUE" });
  }
  async function safeRead(operation){
    try{return await operation();}catch(error){
      if(["FORBIDDEN","UNAUTHENTICATED","BAD_REQUEST","NOT_FOUND","TEAM_SCHEMA_NOT_READY"].includes(error?.code))throw error;
      fail("小组数据暂时无法读取，请稍后重试。","TEAM_SERVICE_UNAVAILABLE");
    }
  }
  return { available, scope, scopeId, leader, member, context, customerScope, safeRead };
}

module.exports = { createTeacherTeamReads };
