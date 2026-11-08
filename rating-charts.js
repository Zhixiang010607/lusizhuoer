(() => {
  "use strict";
  const colors=["#a9554b","#c87348","#c39945","#82905e","#47745e"];
  const percent=(n,total)=>total?`${(n*100/total).toFixed(1)}%`:"0.0%";
  function chart(title,center,label,legend,note) {
    const total=legend.reduce((s,r)=>s+r.count,0);let cursor=0;
    const gradient=total?legend.filter(r=>r.count>0).map(r=>{const start=cursor;cursor+=r.count*100/total;return `${r.color} ${start}% ${cursor}%`;}).join(","):"#e7ddce 0% 100%";
    return `<article class="panel rating-chart-card"><h2>${title}</h2><div class="rating-chart-body"><div class="rating-donut" role="img" aria-label="${title}：${legend.map(r=>`${r.label} ${r.count} 单`).join('，')}" style="background:conic-gradient(${gradient})"><div><strong>${center}</strong><span>${label}</span></div></div><div class="rating-chart-legend"><div class="rating-legend-head"><span>分类</span><span>数量</span><span>占比</span></div>${legend.map(r=>`<div><span><i style="background:${r.color}"></i>${r.label}</span><strong>${r.count}</strong><span>${percent(r.count,total)}</span></div>`).join("")}</div></div><p>${note}</p></article>`;
  }
  function render(node,summary={}) {
    const total=Math.max(0,Number(summary.total||0)),rated=Math.max(0,Number(summary.rated||0));
    const scores=colors.map((color,i)=>({color,label:`${i+1} 分`,count:Math.max(0,Number(summary.scoreCounts?.[i+1]||0))}));
    const coverage=[{label:"已评价",count:rated,color:"#9b7335"},{label:"未评价",count:Math.max(0,Number(summary.unrated??total-rated)),color:"#d8cbb8"}];
    node.innerHTML=chart("1–5 分分布",rated,"已评价",scores,"仅统计当前条件下已评价工单；0 分未评价不进入本图。")+chart("评价覆盖率",percent(rated,total),"评价覆盖率",coverage,"按当前门店、项目、老师和时间范围统计全部可评价工单。"); node.hidden=false;
  }
  window.RatingCharts=Object.freeze({render});
})();
