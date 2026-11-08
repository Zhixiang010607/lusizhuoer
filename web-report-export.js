(() => {
  "use strict";
  const xml = (v) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"})[c]);
  const units = (v) => Array.from(String(v ?? "")).reduce((n,c)=>n+(c.codePointAt(0)>127?2:1),0);
  const beijingDate = (v) => v === "从未核销" ? v : /^\d{4}-\d{2}-\d{2}$/.test(String(v||"")) ? v : window.AppDateTime.formatDate(v);
  const columnName = (n) => { let text=""; for(n++;n>0;n=Math.floor((n-1)/26))text=String.fromCharCode(65+(n-1)%26)+text; return text; };
  const encoder = new TextEncoder();
  const join = (parts) => {const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let i=0;for(const p of parts){out.set(p,i);i+=p.length;}return out;};
  function crc(bytes) {let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;}
  function binary(size, entries) {const b=new Uint8Array(size),v=new DataView(b.buffer);for(const [o,n,w]of entries)w===2?v.setUint16(o,n,true):v.setUint32(o,n>>>0,true);return b;}
  function zip(files) {
    const local=[],central=[];let offset=0;
    for(const [path,source]of files){
      const name=encoder.encode(path),data=encoder.encode(source),sum=crc(data);
      const h=binary(30,[[0,0x04034b50,4],[4,20,2],[6,0x800,2],[12,33,2],[14,sum,4],[18,data.length,4],[22,data.length,4],[26,name.length,2]]);
      local.push(h,name,data);
      central.push(binary(46,[[0,0x02014b50,4],[4,20,2],[6,20,2],[8,0x800,2],[14,33,2],[16,sum,4],[20,data.length,4],[24,data.length,4],[28,name.length,2],[42,offset,4]]),name);
      offset+=h.length+name.length+data.length;
    }
    const directory=join(central);
    return join([...local,directory,binary(22,[[0,0x06054b50,4],[8,files.length,2],[10,files.length,2],[12,directory.length,4],[16,offset,4]])]);
  }
  function workbook(columns, rows) {
    const values=rows.map(r=>columns.map(([key,,type])=>type==="date"?beijingDate(r[key]):r[key]));
    const widths=columns.map(([,label],i)=>Math.min(60,Math.max(10,units(label)+3,...values.map(r=>units(r[i])+3))));
    const cell=(value,r,c,style)=>typeof value==="number"&&Number.isFinite(value)?`<c r="${columnName(c)}${r}" s="${style}"><v>${value}</v></c>`:`<c r="${columnName(c)}${r}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
    const sheet=`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1" bestFit="1"/>`).join("")}</cols><sheetData><row r="1" ht="26" customHeight="1">${columns.map(([,h],i)=>cell(h,1,i,1)).join("")}</row>${values.map((r,i)=>`<row r="${i+2}" ht="23" customHeight="1">${r.map((v,j)=>cell(v,i+2,j,0)).join("")}</row>`).join("")}</sheetData><autoFilter ref="A1:${columnName(columns.length-1)}${rows.length+1}"/></worksheet>`;
    const prefix='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    return zip([
      ["[Content_Types].xml",prefix+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
      ["_rels/.rels",prefix+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ["xl/workbook.xml",prefix+'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="查询结果" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ["xl/_rels/workbook.xml.rels",prefix+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
      ["xl/styles.xml",prefix+'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><name val="Microsoft YaHei"/><color rgb="FF6F532E"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF4E7D0"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="center"/></xf><xf fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
      ["xl/worksheets/sheet1.xml",prefix+sheet]
    ]);
  }
  function download(columns,rows,filename){const bytes=workbook(columns,rows),url=URL.createObjectURL(new Blob([bytes],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"})),link=document.createElement("a");link.href=url;link.download=filename+".xlsx";link.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);}
  window.WebReportExport=Object.freeze({workbook,download,beijingDate});
})();
