(() => {
  "use strict";
  function dateSelector(node, value, end) {
    let maximum=end, current=value;
    const read=()=>Array.from(node.querySelectorAll('select')).map((s,i)=>i?String(s.value).padStart(2,'0'):s.value).join('-');
    function draw() {
      const [y,m,d]=current.split('-').map(Number),[ey,em,ed]=maximum.split('-').map(Number);
      const years=Array.from({length:Math.max(1,ey-2019)},(_,i)=>ey-i);
      const month=Math.min(m,y===ey?em:12),last=new Date(Date.UTC(y,month,0)).getUTCDate(),day=Math.min(d,y===ey&&month===em?ed:last);
      current=`${y}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      node.innerHTML=[['年份',years,y,'年'],['月份',Array.from({length:y===ey?em:12},(_,i)=>i+1),month,'月'],['日期',Array.from({length:y===ey&&month===em?ed:last},(_,i)=>i+1),day,'日']].map(([label,vs,n,suffix])=>`<select aria-label="选择${label}">${vs.map(v=>`<option value="${v}" ${v===n?'selected':''}>${v}${suffix}</option>`).join('')}</select>`).join('');
      node.querySelectorAll('select').forEach(s=>s.addEventListener('change',()=>{current=read();draw();}));
    }
    draw();
    return {value:()=>current,set:(v,e=maximum)=>{maximum=e;current=v;draw();},busy:(b)=>node.querySelectorAll('select').forEach(s=>{s.disabled=b;})};
  }
  function table(node,{rows,head,row,empty}) {
    let page=1;const pages=Math.max(1,Math.ceil(rows.length/10));
    function draw(){
      node.innerHTML=rows.length?`<div class="table-scroll"><table class="tracking-data-table"><thead><tr><th>序号</th>${head.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.slice((page-1)*10,page*10).map((r,i)=>`<tr><td>${i+1}</td>${row(r)}</tr>`).join('')}</tbody></table></div><nav class="tracking-list-pager" aria-label="名单分页"><button data-page="prev" ${page<=1?'disabled':''}>上一页</button><span>第 ${page} / ${pages} 页</span><button data-page="next" ${page>=pages?'disabled':''}>下一页</button><label>跳至第 <input type="number" min="1" max="${pages}" value="${page}" aria-label="跳转到第几页"> 页</label><button data-page="jump">跳转</button><span class="tracking-page-error" role="status"></span></nav>`:`<div class="tracking-empty">${empty}</div>`;
      const go=(n)=>{if(!Number.isInteger(n)||n<1||n>pages){node.querySelector('.tracking-page-error').textContent=`请输入 1 到 ${pages} 的整数页码`;return;}page=n;draw();};
      node.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.page==='prev'?page-1:b.dataset.page==='next'?page+1:Number(node.querySelector('input').value))));
      node.querySelector('input')?.addEventListener('keydown',e=>{if(e.key==='Enter')go(Number(e.target.value));});
    }draw();
  }
  window.WebTrackingUI=Object.freeze({dateSelector,table});
})();
