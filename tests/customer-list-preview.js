"use strict";
// Local-only production-markup fixture. No SDK, session, real account or write API.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const routes = new Set(["customer-query.html", "recharge-query.html", "verification-query.html", "recharge-review.html", "refund-review.html", "verification-review.html", "product-purchase-review.html", "store-detail.html", "teacher-work-orders.html", "teacher-management.html", "store-management.html", "retail-product-management.html", "index.html"]);
const runtime = `(() => {
  document.documentElement.dataset.authReady = 'true';
  if(document.getElementById('storeRecordQueryMain')) {
    document.body.classList.add('store-record-query'); document.body.setAttribute('data-customer-query','');
    document.getElementById('storeRecordQueryMain').hidden=false; document.getElementById('legacyRecordQueryMain').hidden=true;
  }
  const status=document.querySelector('.topbar .status');if(status)status.textContent='隔离样例预览 · 不连接云端';
  const range=document.getElementById('dashboardRangeSummary');if(range)range.textContent='隔离样例预览 · 不连接云端';
  const count = Math.max(0, Math.min(21, Number(new URLSearchParams(location.search).get('rows') ?? 21)));
  const bodies = Array.from(document.querySelectorAll('tbody')).filter(b => /customerQueryBody|recordQueryBody|reviewBody|purchaseReviewBody|CustomerBody|BusinessDetailBody|teacherOrdersBody|StoreRows|TeacherRows|retailProductBody|rankingBody/.test(b.id));
  let page = 1;
  const local = /management.html$/.test(location.pathname);
  function fill() {
    bodies.forEach(b => {
      const headings = Array.from(b.closest('table').querySelectorAll('thead th')).filter(th => !th.classList.contains('list-row-number'));
      const size = local ? count : Math.min(10, Math.max(0, count - (page - 1) * 10));
      b.innerHTML = size ? Array.from({length:size}, (_,i) => '<tr>'+headings.map((th,j) => '<td>' + (j===0 ? '<a class="record-link" href="#">示例'+(local ? i+1 : (page-1)*10+i+1)+'</a>' : th.textContent==='年龄' ? CustomerAge.format('1990-01-01',new Date('2026-10-31T04:00:00Z')) : th.textContent.includes('生日') ? '1990年01月01日' : th.textContent.includes('时间') || th.textContent.includes('日期') ? '2026-10-31 12:34:56' : th.textContent.includes('状态') ? '活跃' : '示例数据') + '</td>').join('')+'</tr>').join('') : '<tr><td colspan="'+headings.length+'" class="query-empty">暂无结果</td></tr>';
    });
    const input = document.getElementById('fixtureJumpInput'); if(input) input.value = String(page);
    const label = document.getElementById('fixturePage'); if(label) label.textContent = '第 '+page+' / '+Math.max(1, Math.ceil(count/10))+' 页';
  }
  fill();
  if(!local) {
    const original=document.querySelector('.record-query-pager, #reviewPagination, .review-pagination, .dashboard-ranking-pagination');
    const nav=original || document.createElement('nav');nav.hidden=false;nav.className='table-pagination list-pagination';
    nav.innerHTML='<button id="fixturePrevious">上一页</button><span id="fixturePage"></span><button id="fixtureNext">下一页</button><label class="list-page-jump">跳至第 <input id="fixtureJumpInput" type="number" value="1" min="1" aria-label="跳转到第几页"> 页</label><button id="fixtureJump">跳转</button>';
    const table=bodies[0]?.closest('.table-scroll'); if(table) table.after(nav);
    const change = value => {if(!Number.isInteger(value)||value<1||value>Math.max(1,Math.ceil(count/10)))return;page=value;fill();document.getElementById('fixturePrevious').disabled=page<=1;document.getElementById('fixtureNext').disabled=page>=Math.ceil(count/10);};
    document.getElementById('fixturePrevious').onclick=()=>change(page-1);document.getElementById('fixtureNext').onclick=()=>change(page+1);document.getElementById('fixtureJump').onclick=()=>change(Number(document.getElementById('fixtureJumpInput').value));change(1);
  }
})();`;
http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:4173");
  const name = decodeURIComponent(url.pathname).replace(/^\//, "");
  const file = path.resolve(root, name || "customer-query.html");
  if (!file.startsWith(root + path.sep) || name.startsWith(".") || !/\.(html|css|js|png|jpg|svg|webp)$/.test(file)) { response.writeHead(403); response.end(); return; }
  try {
    let contents = fs.readFileSync(file);
    if (routes.has(name)) {
      contents = contents.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace("</head>", '<link rel="stylesheet" href="/web-tablet-parity.css"><link rel="stylesheet" href="/list-row-numbers.css"></head>')
        .replace("</body>", '<script src="/customer-age.js"></script><script>'+runtime+'</script><script src="/list-row-numbers.js"></script></body>');
    }
    const type = file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream";
    response.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" }); response.end(contents);
  } catch (_) { response.writeHead(404); response.end(); }
}).listen(4173, "127.0.0.1", () => console.log("Isolated list fixture on http://127.0.0.1:4173/customer-query.html; no production SDKs"));
