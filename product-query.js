(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const clean = (v) => String(v ?? "").trim();
  const escape = (v) => clean(v).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  const statusLabels = {PENDING:"待审核",APPROVED:"审核通过",REJECTED:"已驳回"};
  const today = window.AppDateTime.formatDate(new Date());
  let page = 1, pages = 1, rows = [], loading = false, lastPayload = null;
  function message(text, error = false) { $("productQueryMessage").textContent = text; $("productQueryMessage").classList.toggle("error", error); }
  function dateSelectors(id, label) {
    const [year, month, day] = today.split("-").map(Number);
    const options = (values, selected, suffix) => values.map(v => `<option value="${v}" ${v === selected ? "selected" : ""}>${v}${suffix}</option>`).join("");
    return `<label>${label}<span class="product-date-selectors"><select id="${id}Year" aria-label="${label}年份">${options(Array.from({length: year - 1990 + 1}, (_, i) => year - i), year, "年")}</select><select id="${id}Month" aria-label="${label}月份">${options(Array.from({length:12},(_,i)=>i+1),month,"月")}</select><select id="${id}Day" aria-label="${label}日期">${options(Array.from({length:31},(_,i)=>i+1),day,"日")}</select></span></label>`;
  }
  $("productQueryDates").innerHTML = dateSelectors("productStart", "开始日期") + dateSelectors("productEnd", "结束日期");
  for (const id of ["productStart", "productEnd"]) {
    const refresh = () => {
      const year = Number($(id+"Year").value), month = Number($(id+"Month").value), day = Number($(id+"Day").value);
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
      $(id+"Day").innerHTML = Array.from({length:days},(_,i)=>`<option value="${i+1}" ${i+1===Math.min(day,days)?"selected":""}>${i+1}日</option>`).join("");
    };
    $(id+"Year").addEventListener("change", refresh); $(id+"Month").addEventListener("change", refresh); refresh();
  }
  const selectedDate = (id) => [$(id+"Year").value, $(id+"Month").value.padStart(2,"0"), $(id+"Day").value.padStart(2,"0")].join("-");
  function payload() {
    const period = $("productQueryTime").value;
    const startDate = period === "ALL" ? "" : period === "TODAY" ? today : selectedDate("productStart");
    const endDate = period === "ALL" ? "" : period === "TODAY" ? today : selectedDate("productEnd");
    if (startDate > endDate) throw Error("开始日期不能晚于结束日期");
    const recordCode = clean($("productQueryCode").value).toUpperCase();
    if (recordCode && !/^(?:PP\d{14}|RC\d{12})$/.test(recordCode)) throw Error("请输入完整的产品购买单号或充值单号");
    return {storeId:$("productQueryStore").value, retailProductId:$("productQueryProduct").value, sourceType:$("productQuerySource").value, status:$("productQueryStatus").value, customerName:clean($("productQueryCustomer").value), recordCode, startDate, endDate};
  }
  function renderPager() {
    $("productQueryPage").textContent = `第 ${page} / ${pages} 页`;
    $("productQueryJump").value = String(page); $("productQueryJump").max = String(pages);
    $("productQueryPrev").disabled = loading || page <= 1; $("productQueryNext").disabled = loading || page >= pages;
    $("productQueryGo").disabled = loading; $("productQueryJump").disabled = loading;
  }
  function render() {
    $("productQueryBody").innerHTML = rows.length ? rows.map((r,i) => {
      const gift = r.source_type === "GIFT";
      const order = gift ? `<a href="recharge-detail.html?recordId=${encodeURIComponent(r.record_id || r.id)}&recordCode=${encodeURIComponent(r.record_code)}">${escape(r.record_code)}</a>` : `<button class="product-order-link" type="button" data-order-index="${i}">${escape(r.record_code || r.purchase_code)}</button>`;
      return `<tr><td>${order}</td><td>${gift?"充值赠送":"产品购买"}</td><td><a href="customer-detail.html?customerId=${encodeURIComponent(r.customer_code)}">${escape(r.customer_name)}</a></td><td>${escape(window.CustomerAge.format(r.birth_date))}</td><td>${escape(r.store_name)}</td><td>${escape(r.product_name_snapshot)}</td><td>${Number(r.unit_count || 0)} 件</td><td>${escape(r.teacher_name || "—")}</td><td>${escape(window.AppDateTime.format(r.submitted_at))}</td><td>${escape(statusLabels[r.record_status] || "—")}</td></tr>`;
    }).join("") : '<tr><td colspan="10" class="query-empty">当前条件下没有产品记录</td></tr>';
  }
  const exportController=window.QueryReportExport.mount({kind:"PRODUCT_PURCHASE",readPayload:payload,fetch:p=>window.CloudBasePhoneAuth.queryRetailProductRecords(p),notice:message});
  async function load(target = 1, search = false) {
    if (loading) return;
    let filters; try { filters = search || !lastPayload ? payload() : {...lastPayload}; } catch(e) { message(e.message,true); return; }
    exportController.begin(); loading = true; renderPager();
    document.querySelectorAll("#productQueryForm input, #productQueryForm select, #productQueryForm button").forEach(n=>{n.disabled=true;});
    $("productQueryBody").innerHTML = '<tr><td colspan="10" class="query-empty">正在读取产品记录…</td></tr>'; message("");
    try {
      const result = await window.CloudBasePhoneAuth.queryRetailProductRecords({...filters,pageNumber:target});
      rows = result.orders || []; page = Number(result.pageNumber || 1); pages = Math.max(1,Number(result.totalPages || 1)); lastPayload = filters; exportController.commit(filters);
      const choices = (id, values, name, label) => { const selected=$(id).value; $(id).innerHTML=`<option value="">${label}</option>`+values.map(v=>`<option value="${escape(v.id)}">${escape(v[name])}</option>`).join(""); $(id).value=selected; };
      choices("productQueryStore",(result.stores||[]).map(s=>({id:s.store_id||s.id,name:s.store_name||s.name})),"name","全部门店");
      choices("productQueryProduct",(result.products||[]).map(p=>({id:p.productId,name:p.productName+(p.productStatus==="ARCHIVED"?"（已封存）":"")})),"name","全部产品");
      $("productQueryCount").textContent = `共 ${Number(result.total || 0)} 条`; render();
    } catch(e) { rows=[]; $("productQueryBody").innerHTML='<tr><td colspan="10" class="query-empty">读取失败，请重试</td></tr>'; message(e.message||"产品查询失败",true); }
    finally { loading=false; document.querySelectorAll("#productQueryForm input, #productQueryForm select, #productQueryForm button").forEach(n=>{n.disabled=false;}); renderPager(); }
  }
  function jump() { const target=Number($("productQueryJump").value); if(!Number.isInteger(target)||target<1||target>pages) {message(`请输入 1 到 ${pages} 的整数页码`,true);return;} void load(target); }
  $("productQueryForm").addEventListener("submit",e=>{e.preventDefault();void load(1,true);});
  $("productQueryTime").addEventListener("change",()=>{$("productQueryDates").hidden=$("productQueryTime").value!=="CUSTOM";});
  $("productQueryReset").addEventListener("click",()=>{$("productQueryForm").reset(); $("productQueryDates").hidden=true; void load(1,true);});
  $("productQueryPrev").addEventListener("click",()=>void load(page-1)); $("productQueryNext").addEventListener("click",()=>void load(page+1));
  $("productQueryGo").addEventListener("click",jump); $("productQueryJump").addEventListener("keydown",e=>{if(e.key==="Enter")jump();});
  $("productQueryBody").addEventListener("click",e=>{const b=e.target.closest("[data-order-index]");if(!b)return;const r=rows[Number(b.dataset.orderIndex)];if(!r)return;
    $("productQueryDetailContent").innerHTML=[["工单号",r.record_code||r.purchase_code],["客户",r.customer_name],["门店",r.store_name],["产品",r.product_name_snapshot],["数量",`${r.unit_count} 件`],["老师",r.teacher_name||"—"],["提交时间（北京）",window.AppDateTime.format(r.submitted_at)],["审核状态",statusLabels[r.record_status]],["申请留言",r.message||"无"],["审核留言",r.review_note||"无"]].map(([k,v])=>`<div><dt>${escape(k)}</dt><dd>${escape(v)}</dd></div>`).join(""); $("productQueryDetail").showModal();});
  $("productQueryClose").addEventListener("click",()=>$("productQueryDetail").close());
  void load(1,true);
})();
