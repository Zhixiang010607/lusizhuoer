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
  function workbookSheets(tables) {
    const prefix='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const documents=tables.map(({columns,rows,name="查询结果",narrative=false,title="日报情况",criteria=""})=>{
      if(narrative){let n=1;const parts=[],merges=[],breaks=[];const add=(text,height,style=2)=>{merges.push(`A${n}:F${n}`);parts.push(`<row r="${n}" ht="${height}" customHeight="1"><c r="A${n}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c></row>`);n++;};add(title,32,1);add(criteria,26,0);
        const complete=rows.filter(r=>r.completed);for(const row of complete){if(n>3)breaks.push(n-1);add(`${row.teacher} · ${row.phone || "未登记电话"}`,28,1);add(`提交时间（北京时间）：${row.time}`,25,0);const lines=[];for(const para of String(row.content||"—").split(/\r?\n/)){let line="";for(const ch of Array.from(para)){if(line&&units(line+ch)>105){lines.push(line);line=ch;}else line+=ch;}lines.push(line||" ");}for(let at=0;at<lines.length;at+=20){const chunk=lines.slice(at,at+20);add(chunk.join("\n"),chunk.length*18+14);}n++;}if(!complete.length)add("所选日期暂无已填写日报",28,0);
        return{name,xml:`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews><cols><col min="1" max="6" width="18" customWidth="1"/></cols><sheetData>${parts.join("")}</sheetData><mergeCells count="${merges.length}">${merges.map(ref=>`<mergeCell ref="${ref}"/>`).join("")}</mergeCells><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>${breaks.length?`<rowBreaks count="${breaks.length}" manualBreakCount="${breaks.length}">${breaks.map(id=>`<brk id="${id}" min="0" max="16383" man="1"/>`).join("")}</rowBreaks>`:""}</worksheet>`};
      }
      const values=rows.map(r=>columns.map(([key,,type])=>type === "date"?beijingDate(r[key]):r[key]));
      const widths=columns.map(([key,label],i)=>Math.min(255,Math.max(10,units(label)+3,...values.map(r=>units(r[i])+3))));
      const cell=(value,r,c,style)=>typeof value === "number"&&Number.isFinite(value)?`<c r="${columnName(c)}${r}" s="${style}"><v>${value}</v></c>`:`<c r="${columnName(c)}${r}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
      let rowIndex=2;const records=[];
      for(const valuesRow of values){const cells=valuesRow.map((v,i)=>String(v??"—").split(/\r?\n/).flatMap(part=>{const out=[];let current="";for(const ch of Array.from(part)){if(current&&units(current+ch)>widths[i]-2){out.push(current);current=ch;}else current+=ch;}out.push(current||"—");return out;}));const lines=Math.max(...cells.map(c=>c.length));
        for(let offset=0;offset<lines;offset+=21){const height=Math.max(28,Math.min(21,lines-offset)*18+10);records.push(`<row r="${rowIndex}" ht="${height}" customHeight="1">${cells.map((list,i)=>cell(!offset&&typeof valuesRow[i] === "number"?valuesRow[i]:list.length>21?list.slice(offset,offset+21).join("\n"):offset?"":valuesRow[i],rowIndex,i,3)).join("")}</row>`);rowIndex++;}}
      return{name,xml:`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1" bestFit="1"/>`).join("")}</cols><sheetData><row r="1" ht="28" customHeight="1">${columns.map(([,h],i)=>cell(h,1,i,4)).join("")}</row>${records.join("")}</sheetData><autoFilter ref="A1:${columnName(columns.length-1)}${rowIndex-1}"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`};
    });
    const entries=[
      ["[Content_Types].xml",prefix+`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${documents.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`],
      ["_rels/.rels",prefix+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ["xl/workbook.xml",prefix+`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${documents.map((d,i)=>`<sheet name="${xml(d.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join("")}</sheets></workbook>`],
      ["xl/_rels/workbook.xml.rels",prefix+`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${documents.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join("")}<Relationship Id="rId${documents.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      ["xl/styles.xml",prefix+'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="12"/><name val="Microsoft YaHei"/></font><font><b/><sz val="12"/><name val="Microsoft YaHei"/><color rgb="FF6F532E"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF4E7D0"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="5"><xf fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="center"/></xf><xf fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"><alignment horizontal="center" vertical="center"/></xf><xf fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="top" wrapText="1"/></xf><xf fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
      ...documents.map((d,i)=>[`xl/worksheets/sheet${i+1}.xml`,prefix+d.xml])
    ];return zip(entries);
  }
  function workbook(columns,rows){return workbookSheets([{columns,rows}]);}
  function download(columns,rows,filename){const bytes=workbook(columns,rows),url=URL.createObjectURL(new Blob([bytes],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"})),link=document.createElement("a");link.href=url;link.download=filename+".xlsx";link.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);}
  window.WebReportExport=Object.freeze({workbook,workbookSheets,download,beijingDate});
})();
