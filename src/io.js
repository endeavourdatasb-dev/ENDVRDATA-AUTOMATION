(function (root) {
  'use strict';
  const E = root.SurveyEngine;
  const MAX_FILE = 25 * 1024 * 1024, MAX_EXPANDED = 250 * 1024 * 1024;
  const encode = s => new TextEncoder().encode(s);
  const decode = (bytes, encoding = 'utf-8') => new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const nameSafe = s => String(s || 'file').normalize('NFKC').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0,100) || 'file';
  function base64(bytes) {
    let str = ''; for (let i = 0; i < bytes.length; i += 16384) str += String.fromCharCode(...bytes.subarray(i,i+16384));
    return btoa(str);
  }
  const unbase64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  function unzip(bytes, max = MAX_EXPANDED) {
    let total = 0, entries = 0;
    return root.fflate.unzipSync(bytes, { filter(file) {
      E.assert(++entries <= 4000, 'The archive contains too many files.');
      E.assert(!file.name.startsWith('/') && !file.name.includes('\\') && !file.name.split('/').includes('..') && !file.name.includes('\u0000') && !/^[A-Za-z]:/.test(file.name), 'Unsafe archive path.');
      total += file.originalSize;
      E.assert(Number.isSafeInteger(total) && total <= max && file.originalSize >= 0, 'Expanded archive exceeds the supported size limit.');
      return true;
    }});
  }
  function csv(text, delimiter) {
    const rows = [], row = []; let s = '', quoted = false, afterQuote = false;
    text = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') { if (text[i+1] === '"') { s += '"'; i++; } else { quoted = false; afterQuote = true; } }
        else s += ch;
      } else if (ch === '"') {
        E.assert(s === '' && !afterQuote, 'Invalid CSV quoting near row ' + (rows.length+1) + '.'); quoted = true;
      } else if (ch === delimiter) { row.push(s); s = ''; afterQuote = false; }
      else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && text[i+1] === '\n') i++;
        row.push(s); rows.push(row.splice(0)); s = ''; afterQuote = false;
      } else { E.assert(!afterQuote, 'Unexpected text after a closing CSV quote.'); s += ch; }
      E.assert(rows.length <= 10010 && row.length <= 500 && s.length <= 1000000, 'Text file exceeds row, column or cell-length limits.');
    }
    E.assert(!quoted, 'The file ends inside a quoted value.');
    if (s !== '' || row.length || afterQuote) { row.push(s); rows.push(row); }
    return rows.map(r => r.map(E.cell));
  }
  function jsonTable(text) {
    const data = JSON.parse(text);
    E.assert(Array.isArray(data) && data.length && data.length <= 10000, 'JSON must be an array of 1–10,000 flat respondent objects.');
    E.assert(data.every(r => r && typeof r === 'object' && !Array.isArray(r)), 'Each JSON respondent must be an object.');
    const columns = [...new Set(data.flatMap(Object.keys))];
    E.assert(columns.length <= 500 && columns.every(n => n.trim() && !E.unsafe(n)), 'Invalid JSON field names or too many columns.');
    for (const row of data) for (const v of Object.values(row)) E.assert(v === null || ['string','number','boolean'].includes(typeof v), 'Nested JSON is not supported. Use flat fields with text, numbers, booleans or null.');
    return [columns.map(E.cell), ...data.map(r => columns.map(k => E.cell(Object.hasOwn(r,k) ? r[k] : null)))];
  }
  function fromSheet(c) {
    if (!c || c.t === 'z') return E.cell(null);
    const out = { t: c.t, v: c.v === undefined ? null : c.v };
    if (c.f || c.F) out.f = c.f || '[array formula]';
    if (c.z) out.z = c.z;
    if (c.t === 'n' && c.z && root.XLSX.SSF.is_date(c.z)) {
      const date = root.XLSX.SSF.parse_date_code(c.v);
      if (date) out.date = `${String(date.y).padStart(4,'0')}-${String(date.m).padStart(2,'0')}-${String(date.d).padStart(2,'0')}`;
    }
    if (c.t === 'd') { out.v = c.v instanceof Date ? c.v.toISOString() : String(c.v); out.date = out.v.slice(0,10); }
    return out;
  }
  async function readInput(file, settings = {}) {
    E.assert(file.size <= MAX_FILE, 'Maximum input size is 25 MB per file.');
    const bytes = new Uint8Array(await file.arrayBuffer()), ext = file.name.split('.').pop().toLowerCase();
    const sourceHash = await E.hash(bytes);
    let tables;
    if (['csv','tsv','txt'].includes(ext)) {
      const separator = settings.delimiter === 'tab' ? '\t' : settings.delimiter || (ext === 'csv' ? ',' : '\t');
      tables = [{ name: 'Responses', cells: csv(decode(bytes, settings.encoding || 'utf-8'), separator) }];
    } else if (ext === 'json') tables = [{ name: 'Responses', cells: jsonTable(decode(bytes)) }];
    else if (['xlsx','xls','ods'].includes(ext)) {
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
        const files = unzip(bytes);
        E.assert(!Object.keys(files).some(n => /vbaProject\.bin|xl\/externalLinks\//i.test(n)), 'Macro-containing workbooks and external workbook links are not supported.');
      }
      const book = root.XLSX.read(bytes, { type: 'array', cellFormula: true, cellNF: true, cellDates: false, bookVBA: true, sheetRows: 10002, WTF: false });
      E.assert(!book.vbaraw, 'Macro-containing workbooks are not supported.');
      tables = book.SheetNames.map(name => {
        const sheet = book.Sheets[name];
        if (!sheet['!ref']) return { name, cells: [], hidden: !!book.Workbook?.Sheets?.find(x=>x.name===name)?.Hidden };
        const range = root.XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref']);
        E.assert(range.e.r < 10001 && range.e.c < 500, 'Worksheet exceeds 10,000 respondent rows or 500 columns. Split the file before import.');
        const cells = [];
        for (let r = 0; r <= range.e.r; r++) {
          const row = []; for (let c = 0; c <= range.e.c; c++) row.push(fromSheet(sheet[root.XLSX.utils.encode_cell({r,c})]));
          cells.push(row);
        }
        return { name, cells, hidden: !!book.Workbook?.Sheets?.find(x=>x.name===name)?.Hidden };
      });
    } else throw Error('Supported data: .xlsx, .xls, .ods, .csv, .tsv, .txt and flat .json. SPSS .sav and macro-enabled files are not supported in this version.');
    E.assert(tables.length && tables.some(t => t.cells.length), 'No table data was found.');
    return { name: file.name, sourceHash, bytes64: base64(bytes), size: bytes.length, tables };
  }
  function columnsAt(table, headerRow) {
    E.assert(Number.isInteger(headerRow) && headerRow >= 1 && headerRow <= table.cells.length, 'Choose a valid header row.');
    const cells = table.cells[headerRow-1];
    const width = Math.max(...table.cells.slice(headerRow-1).map(r => r.length));
    const columns = Array.from({length: width}, (_,i) => E.text(cells[i]));
    E.assert(columns.length && columns.every(n => n.trim() && !E.unsafe(n)), 'Each used column needs a non-empty, safe header. Choose another header row or fix the source file.');
    E.assert(new Set(columns).size === columns.length, 'Duplicate column headers are not supported. Fix the source headers before importing.');
    return columns;
  }
  function importDataset(p, input, tableIndex, headerRow, mapping, actor, receipt = {}) {
    E.actorCheck(p, actor, ['cleaner']);
    const table = input.tables[tableIndex]; E.assert(table, 'Choose a worksheet.');
    const columns = columnsAt(table, headerRow), data = table.cells.slice(headerRow);
    E.assert(data.length > 0 && data.length <= 10000, 'Select a table with 1–10,000 respondent rows.');
    E.assert(!p.datasets.some(d => d.sourceHash === input.sourceHash && d.sheet === table.name && d.headerRow === headerRow), 'This exact file and table are already registered.');
    let fields = p.fields;
    if (!fields.length) {
      fields = columns.map(E.defaultField);
      const id = fields.find(f => /^(respondent.?id|resp.?id|id)$/i.test(f.name)); if (id) id.id = true;
      mapping = Object.fromEntries(fields.map(f => [f.name,f.name]));
    }
    E.assert(fields.every(f => columns.includes(mapping[f.name])), 'Map every questionnaire field to an existing source column.');
    E.assert(new Set(Object.values(mapping)).size === fields.length, 'A source column cannot map to two questionnaire fields.');
    const rename = new Map(Object.entries(mapping).map(([field,source]) => [source,field]));
    const outputColumns = columns.map(c => rename.get(c) || c);
    E.assert(new Set(outputColumns).size === outputColumns.length, 'Mapped field names conflict with additional source columns.');
    E.invalidate(p, actor, 'New dataset registered', !p.fields.length);
    if (!p.fields.length) p.fields = fields;
    const d = { id: E.uid(), name: input.name, sourceHash: input.sourceHash, source64: input.bytes64, sourceSize: input.size, sheet: table.name, headerRow, sourceColumns: columns, outputColumns, mapping: E.clone(mapping),
      receiptAt: receipt.receivedAt || E.now(), source: receipt.source || p.source, vendor: receipt.vendor || p.vendor, allSheets: input.tables.map(t=>({name:t.name,hidden:!!t.hidden})),
      rows: data.map((cells,i) => {
        const original = Object.fromEntries(columns.map((name,j) => [name, E.clone(cells[j] || E.cell(null))]));
        const current = Object.fromEntries(outputColumns.map((name,j) => [name, E.clone(cells[j] || E.cell(null))]));
        return { key: `${input.sourceHash}:${table.name}:${headerRow+i+1}`, sourceRow: headerRow+i+1, original, current, excluded: null, inspected: null, eligibility: null };
      }), issueLog: [], changes: [], decisions: [], scannedAt: null, lastRunApproval: null };
    p.datasets.push(d); E.registerCleaner(p,actor);
    d.health = E.rawHealth(p,d);
    E.audit(p, 'Dataset receipt registered', actor, { datasetId: d.id, name: d.name, sourceHash: d.sourceHash, sheet: d.sheet, headerRow, originalCount: d.rows.length, mapping, receiptAt: d.receiptAt, source: d.source, vendor: d.vendor });
    E.scanDataset(p,d); return d;
  }
  function splitCodes(v) {
    if (v === null || v === undefined || String(v).trim() === '') return [];
    const s = String(v);
    return [...new Set(s.split(s.includes('|') ? '|' : ',').map(x => x.trim()).filter(x => x !== ''))];
  }
  function stamp(d = new Date()) { return d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0'); }
  function datasetFileName(p, d, approved) {
    const part = x => nameSafe(String(x).replace(/\.[^.]+$/,'')).replace(/_+/g,'_').slice(0,40);
    const multi = p.datasets.length > 1 ? '_' + d.id.slice(0,4) : '';
    return [part(p.name), part(p.mode), part(d.name) + multi, stamp(), approved ? p.approval.version : 'WORKING', approved ? 'APPROVED' : 'DRAFT'].join('_') + '.xlsx';
  }
  function tableSheet(columns, rows) {
    const sheet = root.XLSX.utils.aoa_to_sheet([columns]);
    rows.forEach((row,r) => columns.forEach((col,c) => {
      const source = row[col] || E.cell(null); if (source.v === null) return;
      const out = { t: source.t, v: source.v };
      if (source.t === 'd') { out.t = 's'; out.v = source.v; }
      if (source.z && source.t === 'n') out.z = source.z;
      // Formula/hyperlink/rich text properties are never copied into output.
      sheet[root.XLSX.utils.encode_cell({r:r+1,c})] = out;
    }));
    sheet['!ref'] = root.XLSX.utils.encode_range({s:{r:0,c:0},e:{r:rows.length,c:Math.max(0,columns.length-1)}});
    sheet['!cols'] = columns.map(n => ({wch: Math.max(12,Math.min(32,n.length+3))}));
    sheet['!autofilter'] = { ref: sheet['!ref'] };
    return sheet;
  }
  function logSheet(records) {
    if (!records.length) return tableSheet(['Status'],[{Status:E.cell('No records')}]);
    const cols = [...new Set(records.flatMap(Object.keys))];
    const fit = v => typeof v === 'string' && v.length > 32000 ? v.slice(0, 32000) + ' …[truncated; full record in LOGS/history.json]' : v;
    return tableSheet(cols, records.map(r => Object.fromEntries(cols.map(k => [k,E.cell(r[k] === undefined ? null : fit(r[k] && typeof r[k] === 'object' ? E.stable(r[k]) : r[k]))]))));
  }
  function datasetWorkbook(p,d) {
    const book = root.XLSX.utils.book_new();
    const included = d.rows.filter(r=>!r.excluded);
    // Resp # = the row number in the raw file; added columns are recalculated from the current answers.
    const RESP = E.RESP_COL, resp = p.respNumber ? [RESP] : [], added = (p.derived||[]).map(x=>x.name);
    const columns = [...resp, ...d.outputColumns, ...added];
    const out = r => ({ ...r.current, ...E.derive(p,r.current).values, ...(p.respNumber ? { [RESP]: E.cell(r.sourceRow) } : {}) });
    const outRows = included.map(out);
    const sheet = tableSheet(columns,outRows);
    root.XLSX.utils.book_append_sheet(book,sheet,'Cleaned data');
    root.XLSX.utils.book_append_sheet(book,tableSheet(['Source row key',...columns],d.rows.filter(r=>r.excluded).map(r=>({'Source row key':E.cell(r.key),...out(r)}))), 'Excluded records');
    const flags=new Map(); for(const i of E.allIssues(p)) if(i.datasetId===d.id && i.decision?.action==='retain') flags.set(i.rowKey,[...(flags.get(i.rowKey)||[]),(i.field?i.field+': ':'')+i.code]);
    root.XLSX.utils.book_append_sheet(book,logSheet(d.rows.map(r=>({[RESP]:r.sourceRow,sourceRowKey:r.key,respondent:r.respondent,status:r.excluded?'EXCLUDED':flags.has(r.key)?'INCLUDED WITH ACCEPTED FLAG':'INCLUDED',acceptedFlags:(flags.get(r.key)||[]).join('; '),exclusion:r.excluded?.reason||'',inspectedBy:r.inspected?.by||'',inspectedAt:r.inspected?.at||''}))), 'Record status');
    const bytes = root.XLSX.write(book,{bookType:'xlsx',type:'array',compression:true});
    // Verify the reporting sheet before offering a release.
    const round = root.XLSX.read(bytes,{type:'array',cellNF:true});
    const check = round.Sheets['Cleaned data'];
    outRows.forEach((row,ri)=>columns.forEach((name,ci)=>{
      const original = row[name] || E.cell(null), output = check[root.XLSX.utils.encode_cell({r:ri+1,c:ci})];
      E.assert(original.v === null ? !output || output.v === null : output && output.v === original.v && output.t === (original.t==='d'?'s':original.t), 'Excel round-trip check failed for '+name+' on source row '+included[ri].sourceRow+'.');
    }));
    return new Uint8Array(bytes);
  }
  function logsWorkbook(p) {
    const b = root.XLSX.utils.book_new();
    const records = {
      'Receipt':p.datasets.map(d=>({datasetId:d.id,file:d.name,sourceHash:d.sourceHash,sheet:d.sheet,headerRow:d.headerRow,receivedAt:d.receiptAt,count:d.rows.length,source:d.source,vendor:d.vendor,allSheets:d.allSheets})),
      'Issues':p.datasets.flatMap(d=>d.issueLog.map(i=>({...i,decision:d.decisions.find(x=>x.issueId===i.id)||null}))),
      'Changes':p.datasets.flatMap(d=>d.changes.map(c=>({dataset:d.name,...c}))),
      'Exclusions':p.datasets.flatMap(d=>d.rows.filter(r=>r.excluded).map(r=>({dataset:d.name,key:r.key,...r.excluded}))),
      'Raw data checks':p.datasets.flatMap(d=>(d.health||E.rawHealth(p,d)).results.map(r=>({file:d.name,check:r.label,result:r.status.toUpperCase(),count:r.count,detail:r.advice,examples:r.examples.map(e=>[e[0]&&'row '+e[0],e[1],e[2]].filter(Boolean).join(' ')).join(' | ')}))),
      'Sample summary':[{project:p.name,mode:p.mode,target:p.target,...E.count(p),moe:p.moe,moeBasis:p.moeBasis}],
      'Verification':p.history.filter(h=>h.event.startsWith('Independent verification')),
      'Approval':p.history.filter(h=>/approval|rejected release|Release exported/.test(h.event)),
      'Audit trail':p.history
    };
    for (const [name,rows] of Object.entries(records)) root.XLSX.utils.book_append_sheet(b,logSheet(rows),name);
    return new Uint8Array(root.XLSX.write(b,{bookType:'xlsx',type:'array',compression:true}));
  }
  function releaseNote(p, destination) {
    return `LOCAL RELEASE RECORD\nProject: ${p.name}\nSurvey mode: ${p.mode}\nFinal included sample: ${E.count(p).included}\nApproved release version: ${p.approval?.version || 'DRAFT'}\nLocal destination (entered by analyst): ${destination || 'Not recorded'}\nReadiness: ${p.approval ? 'Ready for BDR / A&R / VS' : 'DRAFT — NOT APPROVED FOR REPORTING'}\nRetained flags: ${E.allIssues(p).filter(i=>i.decision?.action==='retain').length}\nApproved by: ${p.approval?.by || 'Pending'}\nReviewer: ${p.verification?.by || 'Pending'}\n\nSOP 03 offline adaptation: deterministic rules replace Claude; local package and this note replace online distribution. Operator names are local attestations, not authenticated signatures.\n`;
  }
  async function packageProject(p, approved = false, destination = '') {
    const files = {}, saved = E.clone(p);
    if (saved.qre?.bytes64) { const path='ORIGINAL/QRE_'+nameSafe(saved.qre.name); files[path]=unbase64(saved.qre.bytes64); saved.qre.originalPath=path; delete saved.qre.bytes64; }
    for (const d of saved.datasets) {
      const path='ORIGINAL/'+d.sourceHash.slice(0,12)+'_'+nameSafe(d.name); files[path]=unbase64(d.source64); d.originalPath=path; delete d.source64;
      // Store only working values that differ from the original; rebuilt exactly on open.
      for (const r of d.rows) {
        const diff = {};
        d.outputColumns.forEach((out,j) => { if (E.stable(r.current[out]) !== E.stable(r.original[d.sourceColumns[j]])) diff[out] = r.current[out]; });
        r.currentDiff = diff; delete r.current;
      }
      d.compact = 1;
    }
    files['WORKING/project.json'] = encode(JSON.stringify(saved));
    files['WORKING/rules.json'] = encode(JSON.stringify(E.template(p),null,2));
    files['LOGS/logs.xlsx'] = logsWorkbook(p);
    for (const name of ['history']) files['LOGS/'+name+'.json'] = encode(JSON.stringify(p[name],null,2));
    files['LOGS/sample_summary.json'] = encode(JSON.stringify(E.count(p),null,2));
    for (const d of p.datasets) files[(approved?'APPROVED/':'WORKING/')+datasetFileName(p,d,approved)] = datasetWorkbook(p,d);
    if (approved) files['APPROVED/approved_rules.json'] = encode(JSON.stringify({template:E.template(p),approval:p.ruleApproval},null,2));
    files['release_note.txt'] = encode(releaseNote(p,destination));
    const inventory = [];
    for (const [path,bytes] of Object.entries(files)) inventory.push({path,bytes:bytes.length,sha256:await E.hash(bytes)});
    files['manifest.json']=encode(JSON.stringify({schema:1,type:'local-survey-cleaner-project',appVersion:E.VERSION,projectId:p.id,status:approved?'APPROVED':E.stage(p),snapshotDigest:await E.snapshotHash(p),createdAt:E.now(),files:inventory},null,2));
    return root.fflate.zipSync(files,{level:6});
  }
  async function openPackage(file) {
    E.assert(file.size <= 100*1024*1024, 'Project package exceeds 100 MB.');
    const entries=unzip(new Uint8Array(await file.arrayBuffer()));
    E.assert(entries['manifest.json'] && entries['WORKING/project.json'], 'Not a Local Survey Cleaner project package.');
    const manifest=JSON.parse(decode(entries['manifest.json']));
    E.assert(manifest.schema===1 && manifest.type==='local-survey-cleaner-project' && Array.isArray(manifest.files), 'Unsupported project manifest.');
    E.assert(new Set(manifest.files.map(f=>f.path)).size===manifest.files.length && Object.keys(entries).length===manifest.files.length+1, 'Unexpected or repeated files in package.');
    for (const f of manifest.files) E.assert(entries[f.path] && entries[f.path].length===f.bytes && await E.hash(entries[f.path])===f.sha256, 'File integrity check failed: '+f.path);
    const p=JSON.parse(decode(entries['WORKING/project.json']));
    for (const d of Array.isArray(p.datasets)?p.datasets:[]) if (d.compact===1) {
      E.assert(Array.isArray(d.rows)&&Array.isArray(d.outputColumns)&&Array.isArray(d.sourceColumns)&&d.outputColumns.length===d.sourceColumns.length,'Invalid dataset structure.');
      for (const r of d.rows) {
        E.assert(r && r.original && r.currentDiff && typeof r.currentDiff==='object','Invalid saved row.');
        r.current = Object.fromEntries(d.outputColumns.map((out,j) => [out, Object.hasOwn(r.currentDiff,out) ? r.currentDiff[out] : { ...r.original[d.sourceColumns[j]] }]));
        delete r.currentDiff;
      }
      delete d.compact;
    }
    E.assertProject(p);
    if(p.qre) { E.assert(entries[p.qre.originalPath] && await E.hash(entries[p.qre.originalPath])===p.qre.hash,'Questionnaire file checksum mismatch.'); p.qre.bytes64=base64(entries[p.qre.originalPath]); delete p.qre.originalPath; }
    for (const d of p.datasets) {
      E.assert(entries[d.originalPath] && await E.hash(entries[d.originalPath])===d.sourceHash,'Original survey file checksum mismatch.');
      d.source64=base64(entries[d.originalPath]); delete d.originalPath;
      E.assert(d.rows.every(r=>r.key===`${d.sourceHash}:${d.sheet}:${r.sourceRow}`),'Source row keys do not match their dataset.');
    }
    const digest=await E.snapshotHash(p); E.assert(digest===manifest.snapshotDigest,'Working data does not match the saved snapshot.');
    if(p.verification) E.assert(p.verification.digest===digest,'Verification is stale or invalid.');
    if(p.approval) E.assert(p.approval.digest===digest && p.verification?.passed,'Approval is stale or invalid.');
    return p;
  }
  function templateWorkbook(p) {
    const b=root.XLSX.utils.book_new();
    const fields=(p.fields.length?p.fields:[E.defaultField('respondent_id')]).map(f=>({Field:f.name,Label:f.label,Type:f.type,Respondent_ID:f.id,Required:f.required,Allowed_codes:f.allowed.join(', '),Missing_codes:f.missing.join(', '),Minimum:f.min,Maximum:f.max,Trim:f.trim,Convert_to_number:f.number,Convert_to_text:f.stringify,Multi_separator:f.delimiter,Exclusive_codes:f.exclusive.join(', '),Minimum_selections:f.minSelections,Maximum_selections:f.maxSelections,Clear_skipped:f.clearSkipped}));
    root.XLSX.utils.book_append_sheet(b,logSheet(fields),'Fields');
    root.XLSX.utils.book_append_sheet(b,logSheet(p.fields.flatMap(f=>f.mappings.map(m=>({Field:f.name,From:m.from,To:m.to})))),'Recodes');
    // Structured template data preserves nested conditions losslessly.
    const describe = d => d.kind === 'band' ? d.bands.map(x => x.min + (x.max === null || x.max === undefined ? '+' : '-' + x.max) + ' = ' + E.bandLabel(x)).join('; ')
      : d.kind === 'label' ? d.labels.map(x => x.from + ' = ' + x.to).join('; ') : d.parts.join(' ' + d.sep + ' ');
    root.XLSX.utils.book_append_sheet(b,logSheet([
      ...(p.respNumber ? [{Column:E.RESP_COL,Kind:'Row number in the raw file',From:'',Definition:'First column of the cleaned data'}] : []),
      ...(p.derived||[]).map(d=>({Column:d.name,Kind:{band:'Bands',label:'Labels',combine:'Combine'}[d.kind]||d.kind,From:d.source||'',Definition:describe(d)}))]),'Added columns');
    root.XLSX.utils.book_append_sheet(b,tableSheet(['Template_JSON'],[{Template_JSON:E.cell(JSON.stringify(E.template(p)))}]),'Template');
    root.XLSX.utils.book_append_sheet(b,logSheet([{Instructions:'Edit simple settings on Fields, exact recodes on Recodes. Keep Template sheet for routing/cross-checks and added columns (the Added columns sheet is for reading only; change added columns in the app). Import then review and reapprove. Separate codes with commas (or | if a code contains a comma). A missing code is distinct from an empty cell.'}]),'Instructions');
    return new Uint8Array(root.XLSX.write(b,{bookType:'xlsx',type:'array'}));
  }
  function parseTemplate(bytes,name) {
    let t;
    if(name.endsWith('.json')) t=JSON.parse(decode(bytes));
    else {
      unzip(bytes); const book=root.XLSX.read(bytes,{type:'array'});
      E.assert(book.Sheets.Template && book.Sheets.Fields,'Use a rules workbook exported by this app.');
      t=JSON.parse(book.Sheets.Template.A2?.v || '{}');
      const records=root.XLSX.utils.sheet_to_json(book.Sheets.Fields,{defval:null});
      const yes=v=>v===true || String(v).toLowerCase()==='true';
      const list=splitCodes;
      const num=v=>v===null || v===''?null:Number(v);
      t.fields=records.map(r=>{
        const f=E.clone(t.fields?.find(f=>f.name===r.Field)||E.defaultField(String(r.Field||'')));
        return {...f,name:String(r.Field||''),label:String(r.Label||''),type:String(r.Type||'any'),id:yes(r.Respondent_ID),required:yes(r.Required),allowed:list(r.Allowed_codes),missing:list(r.Missing_codes),min:num(r.Minimum),max:num(r.Maximum),trim:yes(r.Trim),number:yes(r.Convert_to_number),stringify:yes(r.Convert_to_text),delimiter:r.Multi_separator||';',exclusive:list(r.Exclusive_codes),minSelections:num(r.Minimum_selections),maxSelections:num(r.Maximum_selections),clearSkipped:yes(r.Clear_skipped),mappings:[]};
      });
      if(book.Sheets.Recodes) for(const r of root.XLSX.utils.sheet_to_json(book.Sheets.Recodes,{defval:null})) { const f=t.fields.find(f=>f.name===r.Field); if(f)f.mappings.push({from:r.From,to:r.To}); }
    }
    E.assert(t.schema===1 && Array.isArray(t.fields) && t.fields.length<=500 && Array.isArray(t.checks),'Invalid rules template.');
    E.assert((t.derived===undefined || (Array.isArray(t.derived) && t.derived.length<=50)) && (t.respNumber===undefined || typeof t.respNumber==='boolean'),'Invalid added columns in rules template.');
    for(const f of t.fields) E.assert(f.name && !E.unsafe(f.name) && Array.isArray(f.allowed) && Array.isArray(f.missing) && Array.isArray(f.mappings),'Invalid rules field.');
    return t;
  }
  const api={splitCodes,stamp,datasetFileName,MAX_FILE,encode,decode,nameSafe,base64,unbase64,unzip,csv,jsonTable,readInput,columnsAt,importDataset,datasetWorkbook,logsWorkbook,releaseNote,packageProject,openPackage,templateWorkbook,parseTemplate};
  root.SurveyIO=api; if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
