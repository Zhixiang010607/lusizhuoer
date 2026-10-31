"use strict";
// Local-only fixture: exact production Web markup and summary renderer, no SDK or account.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
const start = source.indexOf("  function renderProductSummary()");
const end = source.indexOf("\n  function limited(", start);
if (start < 0 || end < start) throw new Error("Missing production summary renderer");
const renderer = source.slice(start, end);
const script = `(() => {
 document.documentElement.dataset.authReady='true';
 const $=id=>document.getElementById(id), fmt=new Intl.NumberFormat('zh-CN');
 const finiteCount=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
 const finiteNumber=finiteCount, escapeHtml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 const count=Math.max(0,Math.min(21,Number(new URLSearchParams(location.search).get('projects')??3)));
 const names=['海洋之蕴','露思康辰','魔法柔肤'];
 const state={productSummary:{rows:[],total:count,totalPages:Math.max(1,Math.ceil(count/10)),pageNumber:1},data:{totals:{verification:4,recharge:12,experience:3,refund:0}},productSummaryLoading:false};
 ${renderer}
 function show(page){state.productSummary.pageNumber=page;state.productSummary.rows=Array.from({length:Math.min(10,Math.max(0,count-(page-1)*10))},(_,i)=>({name:count<=3?names[i]:'样例项目'+((page-1)*10+i+1),verification:1,recharge:4,experience:1,refund:0}));renderProductSummary();}
 $('productSummaryPrevious').onclick=()=>show(Math.max(1,state.productSummary.pageNumber-1));
 $('productSummaryNext').onclick=()=>show(Math.min(state.productSummary.totalPages,state.productSummary.pageNumber+1));
 show(1);
 const card=document.querySelector('.hq-project-summary-card');
 $('dashboardMain').replaceChildren(card);
})();`;
const assets = new Set(["styles.css", "web-tablet-parity.css", "list-row-numbers.css"]);
http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:4174");
  if (url.pathname === "/index.html") {
    let html = fs.readFileSync(path.join(root, "index.html"), "utf8").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    html = html.replace("</head>", '<link rel="stylesheet" href="/web-tablet-parity.css"></head>')
      .replace("</body>", '<script>'+script+'</script></body>');
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(html);
  } else if (assets.has(url.pathname.slice(1))) {
    response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" }); response.end(fs.readFileSync(path.join(root, url.pathname.slice(1))));
  } else { response.writeHead(404); response.end(); }
}).listen(4174, "127.0.0.1", () => console.log("Isolated summary fixture: http://127.0.0.1:4174/index.html; no cloud SDK or production data"));
