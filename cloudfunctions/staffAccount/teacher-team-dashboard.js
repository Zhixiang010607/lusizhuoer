"use strict";

// Reuse the HQ business attribution CTE and presentation projections. Only this
// dedicated read route injects live membership into facts AND teacher masters.
function createTeacherTeamDashboard({executeSql,teams,dateRange,readMode,rankingRequest,summaryRequest,dateSql,eventsCte,projection,metricColumn,mapRow,version}) {
  function source(range,caller,productId=null) {
    const dates=range?.allTime ? {startDateSql:"'0001-01-01'::date",endDateSql:"(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date"} : dateSql(range);
    const original=eventsCte(dates.startDateSql,dates.endDateSql,productId);
    if(!original.includes("business_events AS (")||!original.includes("SELECT r.store_id,")||!original.includes("SELECT v.store_id,"))throw new Error("Dashboard CTE contract changed");
    return original.replace("business_events AS (","team_source_events AS (")
      .replace("SELECT r.store_id,","SELECT r.submitted_at AS event_at, r.store_id,")
      .replace("SELECT v.store_id,","SELECT v.submitted_at AS event_at, v.store_id,")
      + `, business_events AS (SELECT * FROM team_source_events team_event WHERE ${teams.scope(caller,"team_event.teacher_id")})`;
  }
  function scopedProjection(dimension,caller) {
    const base=projection(dimension);
    const condition=dimension==="teacher" ? teams.scope(caller,"team_rank.entity_id")
      : dimension==="store" ? "EXISTS (SELECT 1 FROM business_events e WHERE e.store_id=team_rank.entity_id)" : "TRUE";
    return `SELECT team_rank.* FROM (${base}) team_rank WHERE ${condition}`;
  }
  async function overview(range,caller) {
    const rows=await executeSql(`${source(range,caller)}, totals AS (
      SELECT COALESCE(SUM(recharge_count),0)::bigint AS recharge,COALESCE(SUM(verification_count),0)::bigint AS verification,
      COALESCE(SUM(experience_count),0)::bigint AS experience,COALESCE(SUM(refund_count),0)::bigint AS refund,
      COUNT(DISTINCT store_id)::bigint AS stores, COUNT(DISTINCT teacher_id)::bigint AS teachers,
      COALESCE(MIN((event_at AT TIME ZONE 'Asia/Shanghai')::date),(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date)::text AS first_date FROM business_events)
      SELECT *, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date::text AS server_today FROM totals`);
    const row=rows[0]||{};
    const startDate=range?.allTime ? row.first_date : range?.startDate||row.server_today;
    const endDate=range?.endDate||row.server_today;
    return {totals:Object.fromEntries(["recharge","verification","experience","refund","stores","teachers"].map(k=>[k,Number(row[k]||0)])),charts:{store:[],teacher:[],project:[]},range:{startDate,endDate}};
  }
  async function page(range,event,caller,summary) {
    const request=summary?summaryRequest(event):rankingRequest(event);
    const dimension=summary?"project":request.dimension;
    const column=summary?"entity_name":metricColumn(request.rankingMetric);
    const order=summary?"entity_name ASC NULLS LAST,entity_code ASC NULLS LAST,entity_id ASC":`${column} DESC,entity_name ASC NULLS LAST,entity_id ASC`;
    const rankingProjection=summary ? `SELECT product.id AS entity_id,COALESCE(product.product_code::text,'') AS entity_code,
      COALESCE(product.product_name::text,'') AS entity_name,COALESCE(SUM(event.recharge_count),0)::bigint AS recharge_count,
      COALESCE(SUM(event.verification_count),0)::bigint AS verification_count,COALESCE(SUM(event.experience_count),0)::bigint AS experience_count,
      COALESCE(SUM(event.refund_count),0)::bigint AS refund_count FROM public.products product LEFT JOIN business_events event ON event.product_id=product.id
      GROUP BY product.id,product.product_code,product.product_name` : scopedProjection(dimension,caller);
    const result=await executeSql(`${source(range,caller,summary?null:request.productId)}, ranked AS (${rankingProjection}),
      totals AS (SELECT COUNT(*)::bigint AS total,COALESCE(SUM(recharge_count+verification_count+experience_count+refund_count),0)::bigint AS business_total,
      ${summary?"0::bigint":`COALESCE(SUM(${column}),0)::bigint`} AS ranking_total FROM ranked),
      team_page_bounds AS (SELECT *,GREATEST(1,CEIL(total::numeric/${request.pageSize}))::bigint AS pages,
      LEAST(${request.pageNumber},GREATEST(1,CEIL(total::numeric/${request.pageSize})))::bigint AS page FROM totals),
      page_rows AS (SELECT *,ROW_NUMBER() OVER(ORDER BY ${order}) AS row_order FROM ranked ORDER BY ${order}
      LIMIT ${request.pageSize} OFFSET (SELECT (page-1)*${request.pageSize} FROM team_page_bounds))
      SELECT JSONB_BUILD_OBJECT('total',total,'pageNumber',page,'totalPages',pages,'businessTotal',business_total,'rankingTotal',ranking_total,
      'rows',COALESCE((SELECT JSONB_AGG(TO_JSONB(item) ORDER BY item.row_order) FROM page_rows item),'[]'::jsonb)) AS payload FROM team_page_bounds`);
    const payload=typeof result[0]?.payload==="string"?JSON.parse(result[0].payload):result[0]?.payload;
    if(!Array.isArray(payload?.rows))throw new Error("Incomplete scoped dashboard result");
    return {[summary?"productSummary":"ranking"]:{...payload,pageSize:request.pageSize,
      ...(summary?{}:{dimension:request.dimension,rankingMetric:request.rankingMetric,productId:request.productId?String(request.productId):""}),rows:payload.rows.map(mapRow)}};
  }
  async function read(caller,event={}) {
    return teams.safeRead(async()=>{await teams.requireLeader(caller);
      if(event.mode==="products"){
        // Shared product master labels support archived-project history; no
        // outside-group business facts or master management are returned.
        const products=await executeSql(`SELECT id::text,product_name,product_status FROM public.products WHERE ${teams.leaderPredicate(caller)} ORDER BY id`);
        await teams.requireLeader(caller);return{ok:true,version,mode:"products",products};
      }
      const range=dateRange(event),mode=readMode(event);
      const payload=mode==="ranking"?await page(range,event,caller,false):mode==="product-summary"?await page(range,event,caller,true):await overview(range,caller);
      await teams.requireLeader(caller);
      return {ok:true,version,mode,...payload};});
  }
  return {read};
}
module.exports={createTeacherTeamDashboard};
