(() => {
  "use strict";
  // Native Web layout. The Mini Program has its own renderer and file APIs.
  const W=841.89,H=595.28,LEFT=38,AVAILABLE=W-76,END=H-36;
  const palette={text:"0.188 0.165 0.133",muted:"0.42 0.373 0.31",gold:"0.475 0.349 0.184",line:"0.86 0.79 0.68",header:"0.957 0.91 0.835"};
  const latinWidths=[278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
  const units=s=>Array.from(String(s??"—")).reduce((n,c)=>n+(c.codePointAt(0)===183?.278:c.codePointAt(0)>=32&&c.codePointAt(0)<=126?latinWidths[c.codePointAt(0)-32]/1000:1),0);
  function wrap(value,width,size) {
    return String(value??"—").split(/\r?\n/).flatMap(part=>{const result=[];let current="";for(const c of Array.from(part)){if(current&&units(current+c)*size>width){result.push(current);current=c;}else current+=c;}result.push(current||"—");return result;});
  }
  function text(cmd,value,x,top,size=12,options={}) {
    const source=String(value??"—");if(options.right)x+=Math.max(0,options.width-units(source)*size);
    let run="",ascii=null;
    function flush(){if(!run)return;const hex=Array.from(run,c=>{const cp=c.codePointAt(0);return (ascii?cp:cp>65535?0x25a1:cp).toString(16).padStart(ascii?2:4,"0").toUpperCase();}).join("");cmd.push(`BT /${ascii?"F2":"F1"} ${size} Tf ${options.color||palette.text} rg ${x.toFixed(2)} ${(H-top-size).toFixed(2)} Td <${hex}> Tj ET`);x+=units(run)*size;run="";}
    for(const c of Array.from(source)){const isAscii=c.codePointAt(0)<128;if(ascii!==null&&ascii!==isAscii)flush();ascii=isAscii;run+=c;}flush();
  }
  function fill(cmd,x,top,width,height,color){cmd.push(`${color} rg ${x} ${H-top-height} ${width} ${height} re f`);}
  function rule(cmd,top,width){cmd.push(`${palette.line} RG 0.4 w ${LEFT} ${H-top} m ${LEFT+width} ${H-top} l S`);}
  function createDocument({title,criteria,sections,detailRows=[]},fontBytes){
    if(!(fontBytes instanceof Uint8Array)||fontBytes.length<1000)throw Error("PDF 中文字体未加载");
    const pages=[];
    const widths=sections.map(section=>section.columns.map(c=>Math.max(units(c.label)*12+24,...section.rows.map(r=>units(r[c.key])*(section.columns.length<=7?13:12)+26))));
    const pageWidth=Math.max(W,...widths.map(ws=>ws.reduce((a,b)=>a+b,0)+LEFT*2));
    function newPage(){const cmd=[];cmd.pageWidth=pageWidth;text(cmd,title,LEFT,28,20,{color:palette.gold});let top=61;wrap(criteria,AVAILABLE,11).forEach(line=>{text(cmd,line,LEFT,top,11,{color:palette.muted});top+=16;});return{cmd,top:top+15};}
    let page=newPage();
    for(const [sectionIndex,section] of sections.entries()){
      const columns=section.columns.map((c,i)=>({...c,points:widths[sectionIndex][i]}));
      const width=columns.reduce((n,c)=>n+c.points,0),size=columns.length<=7?13:12;
      function heading(continued){
        if(section.title){text(page.cmd,section.title+(continued?"（续）":""),LEFT,page.top,15,{color:palette.gold});page.top+=26;}
        let x=LEFT;columns.forEach(c=>{fill(page.cmd,x,page.top,c.points,32,palette.header);text(page.cmd,c.label,x+8,page.top+8,12,{width:c.points-16,right:c.number});x+=c.points;});page.top+=32;
      }
      if(page.top+88>END){pages.push(page.cmd);page=newPage();}heading(false);
      for(const row of section.rows){
        if(page.top+34>END){pages.push(page.cmd);page=newPage();heading(true);}
        let x=LEFT;columns.forEach(c=>{text(page.cmd,String(row[c.key]??"—").replace(/[\r\n]+/g," "),x+8,page.top+10,size,{right:c.number,width:c.points-16});x+=c.points;});page.top+=34;rule(page.cmd,page.top,width);
      }
      page.top+=23;
    }
    pages.push(page.cmd);
    for(const row of detailRows){
      const lines=wrap(row.content,W-96,13);
      for(let offset=0;offset<lines.length;offset+=21){const cmd=[];text(cmd,title,LEFT,28,20,{color:palette.gold});text(cmd,`${row.teacher} · ${row.phone || "未登记电话"}${offset?"（续）":""}`,LEFT,65,14);text(cmd,`提交时间：${row.time}（北京时间）`,LEFT,96,11);fill(cmd,LEFT,124,AVAILABLE,29,palette.header);text(cmd,"日报内容",LEFT+10,130,13);lines.slice(offset,offset+21).forEach((v,i)=>text(cmd,v,LEFT+10,167+i*18,13));pages.push(cmd);}
    }
    return{bytes:(typeof window !== "undefined" ? window.HqDashboardReport : require("./hq-dashboard-report")).createVectorPdf(pages,fontBytes),pages:pages.length};
  }
  let fontPromise;
  async function font(){return fontPromise||=(fetch("assets/fonts/NotoSansCJKsc-Common-Identity.cff?v=1").then(r=>{if(!r.ok)throw Error("PDF 中文字体下载失败");return r.arrayBuffer();}).then(b=>new Uint8Array(b)).catch(e=>{fontPromise=null;throw e;}));}
  function save(bytes,filename,extension){const url=URL.createObjectURL(new Blob([bytes],{type:extension === "pdf"?"application/pdf":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));const a=document.createElement("a");a.href=url;a.download=`${filename.replace(/[\\/:*?"<>|]/g,"-")}.${extension}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  const api={createDocument,font,save};if(typeof window !== "undefined")window.WebTableReport=Object.freeze(api);if(typeof module !== "undefined")module.exports=api;
})();
