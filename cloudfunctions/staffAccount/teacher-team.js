"use strict";

// No client-selected actor/role/leader is accepted for a teacher read. The
// injected caller comes exclusively from staffAccount's currentUser() lookup.
function createTeacherTeams({ executeSql, sqlText, numericId, fail }) {
  // Cache schema presence only; never cache a caller's leadership or members.
  let verifiedSchema = false;
  const boolean = (value) => [true, "true", "t", 1, "1"].includes(value);
  const parsed = (value, fallback = {}) => {
    if (value && typeof value === "object") return value;
    if (typeof value === "string") { try { return JSON.parse(value); } catch (_) {} }
    return fallback;
  };
  const databaseMessages = {
    TEAM_ONLY_HQ: ["仅总部可以任免组长和分配老师。", "FORBIDDEN"],
    TEAM_REMOVE_BEFORE_PROMOTION: ["请先将该老师从原组长名单移除，再设置为组长。", "TEAM_MEMBER_ASSIGNED"],
    TEAM_REMOVE_BEFORE_TRANSFER: ["该老师已归属其他组长，请先从原组移除。", "TEAM_MEMBER_ASSIGNED"],
    TEAM_MEMBER_IS_LEADER: ["组长不能加入其他组长的管理名单。", "TEAM_MEMBER_IS_LEADER"],
    TEAM_TEACHER_NOT_ACTIVE: ["只能添加或任命活跃的普通老师。", "TEAM_TEACHER_NOT_ACTIVE"],
    TEAM_LEADER_NOT_ACTIVE: ["该老师当前不是有效组长，请刷新名单。", "TEAM_LEADER_NOT_ACTIVE"],
    TEAM_TEACHER_NOT_FOUND: ["未找到该老师。", "NOT_FOUND"],
    TEAM_INVALID_MEMBER: ["不能将组长本人加入成员名单。", "BAD_REQUEST"],
    TEAM_INVALID_STATE: ["请选择有效的组长状态。", "BAD_REQUEST"]
  };
  async function query(sql) {
    try { return await executeSql(sql); }
    catch (error) {
      const message = String(error?.message || "");
      for (const [marker, translated] of Object.entries(databaseMessages)) {
        if (message.includes(marker)) fail(...translated);
      }
      fail("小组数据暂时无法读取，请稍后重试。", "TEAM_SERVICE_UNAVAILABLE");
    }
  }
  function requireHq(caller) {
    if (!caller?.uid || caller.profile?.role !== "hq") fail("仅总部可以任免组长和分配老师。", "FORBIDDEN");
  }
  function hqScope(caller) {
    return `EXISTS (SELECT 1 FROM public.staff_accounts team_actor WHERE team_actor.auth_uid = ${sqlText(caller.uid)} AND team_actor.role_code = 'hq' AND team_actor.account_status = 'ACTIVE')`;
  }
  function requireTeacher(caller) {
    if (!caller?.uid || caller.profile?.role !== "teacher" || !caller.profile.teacherId) {
      fail("只有已任命的老师组长可以查看组内数据。", "FORBIDDEN");
    }
  }
  async function available() {
    if (verifiedSchema) return true;
    const rows = await query("SELECT TO_REGPROCEDURE('public.is_teacher_team_leader_v91(text)') IS NOT NULL AND TO_REGPROCEDURE('public.can_read_teacher_team_member_v91(text,bigint)') IS NOT NULL AS ready");
    verifiedSchema = boolean(rows?.[0]?.ready);
    return verifiedSchema;
  }
  async function requireSchema() {
    if (!await available()) fail("小组长功能尚未启用，请联系总部完成更新。", "TEAM_SCHEMA_NOT_READY");
  }
  async function requireLeader(caller) {
    requireTeacher(caller);
    await requireSchema();
    const rows = await query(`SELECT public.is_teacher_team_leader_v91(${sqlText(caller.uid)}) AS enabled`);
    if (!boolean(rows?.[0]?.enabled)) fail("当前没有组长查看权限，请返回个人工作台。", "FORBIDDEN");
  }
  function scope(caller, column) {
    requireTeacher(caller);
    if (!/^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/i.test(column)) throw new Error("Invalid internal team scope column");
    return `public.can_read_teacher_team_member_v91(${sqlText(caller.uid)}, ${column})`;
  }
  function scopeId(caller, teacherId) {
    requireTeacher(caller);
    return `public.can_read_teacher_team_member_v91(${sqlText(caller.uid)}, ${numericId(teacherId, "老师") }::bigint)`;
  }
  function options(event = {}) {
    const page = event.page === undefined ? 1 : Number(event.page);
    if (!Number.isInteger(page) || page < 1 || page > 100000) fail("页码必须是 1 至 100000 的整数。", "BAD_REQUEST");
    const keyword = String(event.keyword || "").trim();
    if (Array.from(keyword).length > 80 || /[\u0000-\u001f\u007f]/.test(keyword)) fail("姓名关键词不超过 80 个字。", "BAD_REQUEST");
    return { page, keyword };
  }
  function teacher(row = {}) {
    return {
      teacherId: String(row.teacher_id || ""), teacherName: String(row.teacher_name || ""),
      phone: String(row.phone || ""), teacherStatus: String(row.teacher_status || ""),
      accountStatus: String(row.account_status || ""), isTeamLeader: boolean(row.is_team_leader),
      assignedLeaderId: String(row.assigned_leader_id || ""), assignedLeaderName: String(row.assigned_leader_name || "")
    };
  }
  async function page(selectSql, requestedPage) {
    const rows = await query(`WITH eligible AS (${selectSql}), totals AS (SELECT COUNT(*) AS total FROM eligible),
      bounds AS (SELECT total, GREATEST(1, CEIL(total::numeric / 10))::bigint AS total_pages,
        LEAST(${requestedPage}, GREATEST(1, CEIL(total::numeric / 10)))::bigint AS page FROM totals),
      page_rows AS (SELECT * FROM eligible ORDER BY teacher_name, teacher_id::bigint
        LIMIT 10 OFFSET (SELECT (page - 1) * 10 FROM bounds))
      SELECT JSONB_BUILD_OBJECT('total', bounds.total, 'page', bounds.page, 'pageSize', 10, 'totalPages', bounds.total_pages,
        'records', COALESCE((SELECT JSONB_AGG(TO_JSONB(item) ORDER BY item.teacher_name, item.teacher_id::bigint) FROM page_rows item), '[]'::jsonb)) AS payload FROM bounds`);
    const payload = parsed(rows?.[0]?.payload);
    if (!Array.isArray(payload.records)) fail("成员名单读取不完整，请重试。", "TEAM_RESULT_UNCONFIRMED");
    return { ...payload, records: payload.records.map(teacher) };
  }
  const teacherFields = `t.id::text AS teacher_id, t.teacher_name, a.phone, t.teacher_status, a.account_status`;

  async function access(caller) {
    requireTeacher(caller);
    if (!await available()) return { ok: true, available: false, isTeamLeader: false, memberCount: 0 };
    const rows = await query(`SELECT public.is_teacher_team_leader_v91(${sqlText(caller.uid)}) AS enabled,
      CASE WHEN public.is_teacher_team_leader_v91(${sqlText(caller.uid)}) THEN
        (SELECT COUNT(*) FROM public.teacher_team_members WHERE leader_teacher_id = ${numericId(caller.profile.teacherId, "当前老师")}::bigint)
        ELSE 0 END AS member_count`);
    return { ok: true, available: true, isTeamLeader: boolean(rows?.[0]?.enabled), memberCount: Number(rows?.[0]?.member_count || 0) };
  }
  async function details(caller, event) {
    requireHq(caller); await requireSchema();
    const teacherId = numericId(event.teacherId, "老师");
    const { page: requestedPage } = options(event);
    const rows = await query(`SELECT ${teacherFields}, COALESCE(l.enabled, FALSE) AS is_team_leader,
      own_membership.leader_teacher_id::text AS assigned_leader_id, owner.teacher_name AS assigned_leader_name
      FROM public.teachers t JOIN public.staff_accounts a ON a.id = t.staff_account_id AND a.role_code = 'teacher'
      LEFT JOIN public.teacher_team_leaders l ON l.teacher_id = t.id
      LEFT JOIN public.teacher_team_members own_membership ON own_membership.member_teacher_id = t.id
      LEFT JOIN public.teachers owner ON owner.id = own_membership.leader_teacher_id
      WHERE t.id = ${teacherId}::bigint AND ${hqScope(caller)} LIMIT 1`);
    if (!rows?.[0]) fail("未找到该老师。", "NOT_FOUND");
    const members = await page(`SELECT ${teacherFields} FROM public.teacher_team_members m
      JOIN public.teachers t ON t.id = m.member_teacher_id
      JOIN public.staff_accounts a ON a.id = t.staff_account_id AND a.role_code = 'teacher'
      JOIN public.teacher_team_leaders l ON l.teacher_id = m.leader_teacher_id AND l.enabled
      WHERE m.leader_teacher_id = ${teacherId}::bigint AND ${hqScope(caller)}`, requestedPage);
    return { ok: true, teacher: teacher(rows[0]), members };
  }
  async function candidates(caller, event) {
    requireHq(caller); await requireSchema();
    const teacherId = numericId(event.teacherId, "组长");
    const filter = options(event);
    const leaders = await query(`SELECT 1 FROM public.teacher_team_leaders l
      JOIN public.teachers t ON t.id = l.teacher_id AND t.teacher_status = 'ACTIVE'
      JOIN public.staff_accounts a ON a.id = t.staff_account_id AND a.role_code = 'teacher' AND a.account_status = 'ACTIVE'
      WHERE l.teacher_id = ${teacherId}::bigint AND l.enabled AND ${hqScope(caller)} LIMIT 1`);
    if (!leaders?.length) fail("该老师当前不是有效组长，请刷新名单。", "TEAM_LEADER_NOT_ACTIVE");
    const result = await page(`SELECT ${teacherFields}, m.leader_teacher_id::text AS assigned_leader_id,
      owner.teacher_name AS assigned_leader_name FROM public.teachers t
      JOIN public.staff_accounts a ON a.id = t.staff_account_id AND a.role_code = 'teacher' AND a.account_status = 'ACTIVE'
      LEFT JOIN public.teacher_team_members m ON m.member_teacher_id = t.id
      LEFT JOIN public.teachers owner ON owner.id = m.leader_teacher_id
      WHERE t.teacher_status = 'ACTIVE' AND t.id <> ${teacherId}::bigint
        AND ${hqScope(caller)}
        AND NOT EXISTS (SELECT 1 FROM public.teacher_team_leaders other WHERE other.teacher_id = t.id AND other.enabled)
        ${filter.keyword ? `AND STRPOS(LOWER(t.teacher_name), LOWER(${sqlText(filter.keyword)})) > 0` : ""}`, filter.page);
    result.records = result.records.map((row) => ({ ...row, canAdd: !row.assignedLeaderId,
      assignmentLabel: row.assignedLeaderId === String(teacherId) ? "已在本组" : row.assignedLeaderId ? `已分配给${row.assignedLeaderName || "其他组长"}` : "未分配" }));
    return { ok: true, candidates: result };
  }
  async function ownMembers(caller, event) {
    await requireLeader(caller);
    const filter = options(event);
    const members = await page(`SELECT ${teacherFields} FROM public.teachers t
      JOIN public.staff_accounts a ON a.id = t.staff_account_id AND a.role_code = 'teacher'
      WHERE ${scope(caller, "t.id")}
        ${filter.keyword ? `AND STRPOS(LOWER(t.teacher_name), LOWER(${sqlText(filter.keyword)})) > 0` : ""}`, filter.page);
    // Check again after the list query. A revoked/archived leader never gets
    // a response containing rows collected just before the permission change.
    await requireLeader(caller);
    return { ok: true, members };
  }
  async function memberProfile(caller, event) {
    await requireLeader(caller);
    const teacherId = numericId(event.teacherId, "老师");
    const rows = await query(`SELECT ${teacherFields} FROM public.teachers t
      JOIN public.staff_accounts a ON a.id = t.staff_account_id AND a.role_code = 'teacher'
      WHERE t.id = ${teacherId}::bigint AND ${scope(caller, "t.id")} LIMIT 1`);
    if (!rows?.[0]) fail("该老师不在你当前的管理名单中。", "FORBIDDEN");
    return { ok: true, teacher: teacher(rows[0]) };
  }
  async function memberEntitlements(caller, event) {
    await memberProfile(caller, event);
    const teacherId = numericId(event.teacherId, "老师");
    const rows = await query(`SELECT q.id::text, q.product_id::text, q.monthly_allowance, q.available_count, q.used_count, q.quota_month,
      p.product_name, p.product_status FROM public.teacher_product_experience_quotas q
      JOIN public.products p ON p.id = q.product_id
      WHERE q.teacher_id = ${teacherId}::bigint AND q.quota_status = 'ACTIVE' AND ${scope(caller, "q.teacher_id")}
      ORDER BY p.product_name, q.id`);
    return { ok: true, entitlements: (rows || []).map((row) => ({ id: String(row.id), productId: String(row.product_id),
      productName: String(row.product_name || ""), productStatus: String(row.product_status || ""),
      monthlyAllowance: Number(row.monthly_allowance || 0), availableCount: Number(row.available_count || 0),
      usedCount: Number(row.used_count || 0), quotaMonth: row.quota_month })) };
  }
  async function mutate(caller, event, membership) {
    requireHq(caller); await requireSchema();
    const flag = membership ? event.assigned : event.enabled;
    if (typeof flag !== "boolean") fail("请选择有效的操作状态。", "BAD_REQUEST");
    const teacherId = numericId(event.teacherId, membership ? "组长" : "老师");
    const call = membership
      ? `public.set_teacher_team_member_v91(${sqlText(caller.uid)}, ${teacherId}::bigint, ${numericId(event.memberTeacherId, "成员老师")}::bigint, ${flag ? "TRUE" : "FALSE"})`
      : `public.set_teacher_team_leader_v91(${sqlText(caller.uid)}, ${teacherId}::bigint, ${flag ? "TRUE" : "FALSE"})`;
    const rows = await query(`SELECT ${call} AS payload`);
    const payload = parsed(rows?.[0]?.payload);
    if (!(membership ? payload.memberTeacherId : payload.teacherId)) {
      fail("操作结果暂未确认，请刷新组长和成员状态后再操作。", "TEAM_RESULT_UNCONFIRMED");
    }
    return { ok: true, ...payload };
  }
  async function handle(action, caller, event = {}) {
    if (action === "getTeamAccess") return access(caller);
    if (action === "getTeacherTeam") return details(caller, event);
    if (action === "listTeacherTeamCandidates") return candidates(caller, event);
    if (action === "setTeacherTeamLeader") return mutate(caller, event, false);
    if (action === "setTeacherTeamMember") return mutate(caller, event, true);
    if (action === "getMyTeacherTeam") return ownMembers(caller, event);
    if (action === "getTeamTeacherProfile") return memberProfile(caller, event);
    if (action === "getTeamTeacherEntitlements") return memberEntitlements(caller, event);
    fail("当前小组操作不可用。", "BAD_REQUEST");
  }
  async function safeRead(operation){
    try{return await operation();}catch(error){
      if(["FORBIDDEN","UNAUTHENTICATED","BAD_REQUEST","NOT_FOUND","TEAM_SCHEMA_NOT_READY","TEAM_SERVICE_UNAVAILABLE","ATTENDANCE_FUTURE_DATE","DAILY_REPORT_FUTURE_DATE"].includes(error?.code))throw error;
      fail("小组数据暂时无法读取，请稍后重试。","TEAM_SERVICE_UNAVAILABLE");
    }
  }
  function leaderPredicate(caller){requireTeacher(caller);return `public.is_teacher_team_leader_v91(${sqlText(caller.uid)})`;}
  return { handle, available, requireLeader, scope, scopeId, safeRead, leaderPredicate };
}

module.exports = { createTeacherTeams };
