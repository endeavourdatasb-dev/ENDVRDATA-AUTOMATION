/* Local Survey Cleaner: deterministic domain logic. No external services. */
(function (root) {
  'use strict';
  const VERSION = '1.0.0';
  const clone = x => JSON.parse(JSON.stringify(x));
  const now = () => new Date().toISOString();
  const uid = () => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const b = globalThis.crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  };
  // Plain SHA-256 used only if the browser withholds crypto.subtle (some browsers do for file:// pages).
  function sha256js(bytes) {
    const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
    const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const len = bytes.length, total = Math.ceil((len + 9) / 64) * 64, m = new Uint8Array(total);
    m.set(bytes); m[len] = 0x80;
    const dv = new DataView(m.buffer); dv.setUint32(total - 8, Math.floor(len / 0x20000000)); dv.setUint32(total - 4, (len * 8) >>> 0);
    const w = new Uint32Array(64), r = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < total; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) w[i] = (r(w[i-15],7) ^ r(w[i-15],18) ^ (w[i-15] >>> 3)) + w[i-16] + (r(w[i-2],17) ^ r(w[i-2],19) ^ (w[i-2] >>> 10)) + w[i-7];
      let [a,b,c,d,e,f,g,h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (r(e,6) ^ r(e,11) ^ r(e,25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((r(a,2) ^ r(a,13) ^ r(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0]+=a; H[1]+=b; H[2]+=c; H[3]+=d; H[4]+=e; H[5]+=f; H[6]+=g; H[7]+=h;
    }
    return Array.from(H, x => x.toString(16).padStart(8, '0')).join('');
  }
  const normalName = x => String(x || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const value = cell => cell && cell.v !== undefined ? cell.v : null;
  const blank = cell => value(cell) === null || value(cell) === '';
  const text = cell => value(cell) === null ? '' : String(value(cell));
  const cell = v => ({ t: v === null || v === undefined ? 'z' : typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : 's', v: v === undefined ? null : v });
  function stable(x) {
    if (Array.isArray(x)) return '[' + x.map(stable).join(',') + ']';
    if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stable(x[k])).join(',') + '}';
    return JSON.stringify(x);
  }
  async function hash(x) {
    const bytes = x instanceof Uint8Array ? x : new TextEncoder().encode(typeof x === 'string' ? x : stable(x));
    if (!globalThis.crypto?.subtle) return sha256js(bytes);
    return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), v => v.toString(16).padStart(2, '0')).join('');
  }
  function assert(ok, message) { if (!ok) throw Error(message); }
  function actorCheck(p, actor, roles) {
    assert(actor && roles.includes(actor.role), 'Switch to ' + roles.join(' or ') + ' to do this.');
    assert(normalName(actor.name), 'Enter your name in Switch person.');
    assert(normalName(actor.name) === normalName(p.roles[actor.role]), 'Your name must match the assigned ' + actor.role + ' in Project details.');
  }
  function audit(p, event, actor, details = {}) {
    p.history.push({ id: uid(), at: now(), event, actor: actor?.name || 'Application', role: actor?.role || 'system', ...clone(details) });
  }
  function invalidate(p, actor, why, template = false, inspection = false) {
    if (p.verification || p.approval) audit(p, 'Sign-offs invalidated', actor, { reason: why, verification: p.verification, approval: p.approval });
    p.verification = null; p.approval = null; p.released = null;
    if (template) { p.ruleApproval = null; inspection = true; }
    if (inspection) for (const d of p.datasets) for (const r of d.rows) r.inspected = null;
    p.revision++; p.updatedAt = now();
  }
  function createProject() {
    return { schema: 1, appVersion: VERSION, id: uid(), name: 'Untitled project', mode: 'CATI', target: '', source: '', vendor: '', moe: 'Not applicable', moeBasis: '', qreVersion: '', qre: null,
      roles: { cleaner: '', reviewer: '', manager: '', releaser: '' }, assignmentReason: '', fields: [], checks: [], eligibility: null, duplicateRows: true,
      ruleApproval: null, datasets: [], history: [], cleaners: [], accounts: [], verification: null, approval: null, released: null, revision: 0, createdAt: now(), updatedAt: now(), demo: false };
  }
  function defaultField(name) {
    return { name, label: '', type: 'any', id: false, required: false, allowed: [], missing: [], min: null, max: null, trim: false, number: false, stringify: false,
      mappings: [], route: null, clearSkipped: false, delimiter: ';', exclusive: [], minSelections: null, maxSelections: null };
  }
  function template(p) {
    return { schema: 1, qreVersion: p.qreVersion, qreHash: p.qre?.hash || '', fields: p.fields, checks: p.checks, eligibility: p.eligibility, duplicateRows: p.duplicateRows };
  }
  function conditionFields(c) { return c?.conditions ? c.conditions.flatMap(conditionFields) : c?.field ? [c.field] : []; }
  const unsafe = n => ['__proto__', 'constructor', 'prototype'].includes(n);
  function validateTemplate(p) {
    const errors = [], names = p.fields.map(f => f.name);
    if (!p.fields.length) errors.push('Add fields or import a dataset to create them.');
    if (p.fields.filter(f => f.id).length !== 1) errors.push('Choose exactly one respondent ID field.');
    if (new Set(names).size !== names.length || names.some(n => !n.trim() || unsafe(n))) errors.push('Field names must be unique, non-empty and safe.');
    const graph = new Map();
    const operators = ['eq', 'neq', 'in', 'notin', 'gt', 'gte', 'lt', 'lte', 'blank', 'answered'];
    function testCondition(c, label) {
      if (!c) return;
      if (c.conditions) {
        if (!['all', 'any'].includes(c.logic) || !c.conditions.length) errors.push(label + ': add conditions and choose all/any.');
        c.conditions.forEach(sub => testCondition(sub, label));
      } else if (!names.includes(c.field) || !operators.includes(c.op)) errors.push(label + ': choose an existing field and supported condition.');
    }
    for (const f of p.fields) {
      if (!['any', 'text', 'number', 'integer', 'date', 'multi'].includes(f.type)) errors.push(f.name + ': unknown field type.');
      if (f.id && f.route) errors.push(f.name + ': the respondent ID cannot have skip logic.');
      if (f.number && f.stringify) errors.push(f.name + ': choose either number conversion or text conversion.');
      if (f.min !== null && f.max !== null && f.min > f.max) errors.push(f.name + ': minimum exceeds maximum.');
      if (f.minSelections !== null && f.maxSelections !== null && f.minSelections > f.maxSelections) errors.push(f.name + ': minimum selections exceeds maximum.');
      if (f.type === 'multi' && (!f.delimiter || f.delimiter.length !== 1)) errors.push(f.name + ': choose a one-character selection separator.');
      if (f.clearSkipped && !f.route) errors.push(f.name + ': clearing skipped answers requires a route.');
      const seen = new Set();
      for (const m of f.mappings || []) {
        const key = String(m.from ?? '');
        if (m.from === '' || m.from === null || seen.has(key)) errors.push(f.name + ': recodes cannot fill blanks or have duplicate source values.');
        seen.add(key);
      }
      // Chained mappings require multiple passes and are deliberately refused.
      for (const a of f.mappings || []) for (const b of f.mappings || []) if (a !== b && String(a.to ?? '') === String(b.from ?? '')) errors.push(f.name + ': chained/cyclic recodes are not allowed.');
      testCondition(f.route, f.name);
      graph.set(f.name, conditionFields(f.route));
    }
    const visiting = new Set(), done = new Set();
    function walk(n) {
      if (visiting.has(n)) { errors.push('Circular skip logic involving ' + n + '.'); return; }
      if (done.has(n)) return;
      visiting.add(n); (graph.get(n) || []).forEach(walk); visiting.delete(n); done.add(n);
    }
    names.forEach(walk);
    for (const c of p.checks) { testCondition(c.when, 'Cross-check'); testCondition(c.expect, 'Cross-check'); }
    testCondition(p.eligibility, 'Eligibility');
    return [...new Set(errors)];
  }
  function updateProject(p, changes, actor) {
    actorCheck(p, actor, ['cleaner', 'manager']);
    const keys = ['name', 'mode', 'target', 'source', 'vendor', 'moe', 'moeBasis', 'qreVersion', 'assignmentReason'];
    const before = Object.fromEntries(keys.map(k => [k, p[k]]));
    const changedTemplate = changes.qreVersion !== undefined && changes.qreVersion !== p.qreVersion;
    invalidate(p, actor, 'Project or role details changed', changedTemplate);
    keys.forEach(k => { if (changes[k] !== undefined) p[k] = changes[k]; });
    if (changes.roles) {
      actorCheck(p, actor, ['manager']);
      assert(['cleaner', 'reviewer', 'manager', 'releaser'].every(k => typeof changes.roles[k] === 'string'), 'Complete the role names.');
      const old = clone(p.roles); p.roles = clone(changes.roles);
      audit(p, 'Role assignment recorded', actor, { before: old, after: p.roles, reason: p.assignmentReason });
    }
    audit(p, 'Project details updated', actor, { before, after: Object.fromEntries(keys.map(k => [k, p[k]])) });
  }
  function updateRules(p, changes, actor) {
    actorCheck(p, actor, ['cleaner', 'manager']);
    invalidate(p, actor, 'Questionnaire rules changed', true);
    for (const key of ['fields', 'checks', 'eligibility', 'duplicateRows']) if (changes[key] !== undefined) p[key] = clone(changes[key]);
    audit(p, 'Questionnaire rules updated', actor, { rules: template(p) });
  }
  async function approveRules(p, actor, note) {
    actorCheck(p, actor, ['manager']);
    assert(p.name.trim() && p.name !== 'Untitled project', 'Enter a project name first.');
    assert(p.qre && p.qreVersion.trim(), 'Attach the approved questionnaire and enter its version.');
    assert(p.moeBasis.trim(), 'Record the sample-design / margin-of-error basis in Project details.');
    assert(note.trim(), 'Record how the questionnaire version and rules were confirmed.');
    const errors = validateTemplate(p); assert(!errors.length, errors.join('\n'));
    const digest = await hash(template(p));
    invalidate(p, actor, 'Rules approval updated');
    p.ruleApproval = { id: uid(), at: now(), by: actor.name, note, digest, qreVersion: p.qreVersion };
    audit(p, 'Questionnaire and rules approved', actor, p.ruleApproval);
    return p.ruleApproval;
  }
  function fieldErrors(f, c) {
    const out = [], v = value(c), s = text(c);
    if (blank(c) || f.missing.map(String).includes(s)) return out;
    if (c?.f) out.push(['FORMULA', 'Formula in a response cell; verify its source before replacement.']);
    if (c?.t === 'e') out.push(['CELL_ERROR', 'Spreadsheet error value.']);
    if (typeof v === 'string' && v.length && !v.trim().length) out.push(['WHITESPACE', 'Whitespace-only response; not treated as an empty cell.']);
    if (f.type === 'text' && typeof v !== 'string') out.push(['TYPE', 'Expected text.']);
    if (['number', 'integer'].includes(f.type) && (typeof v !== 'number' || !Number.isFinite(v) || (f.type === 'integer' && !Number.isInteger(v)))) out.push(['TYPE', 'Expected ' + f.type + '.']);
    if (f.type === 'date' && !(c?.date || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) && new Date(v + 'T00:00:00Z').toISOString().slice(0,10) === v))) out.push(['TYPE', 'Expected an unambiguous date (YYYY-MM-DD or a spreadsheet date).']);
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(v.trim()) ? Number(v) : null;
    if (n !== null && f.type !== 'multi' && ((f.min !== null && n < f.min) || (f.max !== null && n > f.max))) out.push(['RANGE', 'Outside approved range (' + (f.min ?? '…') + ' to ' + (f.max ?? '…') + ').']);
    if (f.type === 'multi') {
      const parts = s.split(f.delimiter);
      if (new Set(parts).size !== parts.length) out.push(['MULTI_DUPLICATE', 'A selection is repeated.']);
      if (f.allowed.length && parts.some(x => !f.allowed.map(String).includes(x))) out.push(['CODE', 'One or more selections are outside the approved code list.']);
      if (parts.some(x => f.exclusive.map(String).includes(x)) && parts.length > 1) out.push(['EXCLUSIVE', 'An exclusive choice appears with another selection.']);
      if ((f.minSelections !== null && parts.length < f.minSelections) || (f.maxSelections !== null && parts.length > f.maxSelections)) out.push(['SELECTION_COUNT', 'Outside the approved number of selections.']);
    } else if (f.allowed.length && !f.allowed.map(String).includes(s)) out.push(['CODE', 'Response is outside the approved code list.']);
    return out;
  }
  function missing(f, c) { return blank(c) || f.missing.map(String).includes(text(c)); }
  function condition(c, row, fields, trail = new Set()) {
    if (!c) return true;
    if (c.conditions) {
      const values = c.conditions.map(sub => condition(sub, row, fields, trail));
      if (c.logic === 'all') return values.includes(false) ? false : values.includes(null) ? null : true;
      return values.includes(true) ? true : values.includes(null) ? null : false;
    }
    const f = fields.find(x => x.name === c.field), v = row[c.field];
    if (!f || trail.has(c.field)) return null;
    if (f.route) {
      const next = new Set(trail); next.add(c.field);
      if (condition(f.route, row, fields, next) !== true) return null;
    }
    if (c.op === 'blank') return missing(f, v);
    if (c.op === 'answered') return !missing(f, v) && fieldErrors(f, v).length === 0;
    if (missing(f, v) || fieldErrors(f, v).length) return null;
    const a = text(v), b = String(c.value ?? '');
    switch (c.op) {
      case 'eq': return a === b;
      case 'neq': return a !== b;
      case 'in': return b.split('|').includes(a);
      case 'notin': return !b.split('|').includes(a);
      case 'gt': case 'gte': case 'lt': case 'lte': {
        if (a.trim() === '' || b.trim() === '' || !Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) return null;
        return c.op === 'gt' ? Number(a) > Number(b) : c.op === 'gte' ? Number(a) >= Number(b) : c.op === 'lt' ? Number(a) < Number(b) : Number(a) <= Number(b);
      }
      default: return null;
    }
  }
  function pushIssue(issues, d, row, field, code, message, rule = code) {
    const observed = field ? clone(row.current[field] || cell(null)) : null;
    const id = stable([row.key, field, rule, observed]);
    issues.push({ id, datasetId: d.id, rowKey: row.key, respondent: row.respondent || '', field, code, rule, message, observed });
  }
  // ---- Standard raw-data checks: the same for every file, whatever the questionnaire ----
  const BAD_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]|\u00C3[\u0080-\u00BF]|\u00E2\u20AC/;
  const SCI = /^[+-]?\d(?:\.\d+)?E[+-]?\d+$/i;
  const NUMLIKE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
  function standardRowChecks(p, d, row) {
    const out = [], cols = d.outputColumns, byName = new Map(p.fields.map(f => [f.name, f])), idName = p.fields.find(f => f.id)?.name;
    let blanks = 0, applicable = 0; const nums = [];
    for (const c of cols) {
      const cellv = row.current[c], f = byName.get(c);
      const asked = !f || !f.route || condition(f.route, row.current, p.fields, new Set([c])) !== false;
      if (asked) applicable++;
      if (blank(cellv)) { if (asked) blanks++; continue; }
      const v = cellv.v;
      if (typeof v === 'string') {
        if (BAD_TEXT.test(v)) out.push([c, 'BAD_TEXT', 'Contains unreadable or corrupted characters (usually a text-encoding problem).']);
        if (SCI.test(v.trim())) out.push([c, 'SCI_NOTATION', 'Looks like a long number turned into scientific notation by Excel. Digits may have been lost.']);
        if (c !== idName && NUMLIKE.test(v.trim())) nums.push(String(Number(v.trim())));
      } else if (typeof v === 'number') {
        if (c === idName && Math.abs(v) >= 1e15) out.push([c, 'SCI_NOTATION', 'Respondent ID is a very long number. Excel keeps only 15 digits, so it may have been changed.']);
        if (c !== idName) nums.push(String(v));
      }
    }
    if (cols.every(c => blank(row.current[c]))) return [['', 'EMPTY_ROW', 'The whole row is empty.']];
    if (applicable >= 4 && blanks / applicable > 0.75) out.push(['', 'MOSTLY_BLANK', `${blanks} of ${applicable} questions this respondent should have answered are blank.`]);
    if (nums.length >= 10 && nums.every(x => x === nums[0]) && !['0', '1'].includes(nums[0])) out.push(['', 'STRAIGHTLINE', `Gave the same answer (${nums[0]}) to all ${nums.length} numeric questions. Possible straight-lining.`]);
    return out;
  }
  // Data-health report on the untouched ORIGINAL values. Fixed list, fixed order.
  function rawHealth(p, d) {
    const cols = d.sourceColumns, rows = d.rows, n = rows.length, ex = [];
    const idField = p.fields.find(f => f.id), idCol = idField ? d.sourceColumns[d.outputColumns.indexOf(idField.name)] : null;
    const isBlank = c => !c || c.v === null || c.v === '';
    const colBlank = cols.map(() => 0), colNum = cols.map(() => 0), colText = cols.map(() => 0);
    const found = { empty: [], dup: [], idBlank: [], idDup: [], sci: [], err: [], formula: [], bad: [], spaces: [], ws: [] };
    const sig = new Map(), ids = new Map();
    for (const r of rows) {
      let blanks = 0;
      cols.forEach((c, j) => {
        const cl = r.original[c];
        if (isBlank(cl)) { colBlank[j]++; blanks++; return; }
        const v = cl.v, at = [r.sourceRow, c, String(v).slice(0, 60)];
        if (cl.f) found.formula.push(at);
        if (cl.t === 'e') found.err.push(at);
        if (typeof v === 'number') { colNum[j]++; if (c === idCol && Math.abs(v) >= 1e15) found.sci.push(at); }
        else if (typeof v === 'string') {
          if (!v.trim()) { found.ws.push(at); return; }
          if (v !== v.trim()) found.spaces.push(at);
          if (BAD_TEXT.test(v)) found.bad.push(at);
          if (SCI.test(v.trim())) found.sci.push(at);
          if (NUMLIKE.test(v.trim())) colNum[j]++; else colText[j]++;
        }
      });
      if (blanks === cols.length) { found.empty.push([r.sourceRow, '', '']); continue; }
      if (idCol && isBlank(r.original[idCol])) found.idBlank.push([r.sourceRow, idCol, '']);
      const key = stable(cols.map(c => r.original[c]?.v ?? null));
      if (!sig.has(key)) sig.set(key, []); sig.get(key).push(r.sourceRow);
      if (idCol && !isBlank(r.original[idCol])) { const id = String(r.original[idCol].v); if (!ids.has(id)) ids.set(id, []); ids.get(id).push(r.sourceRow); }
    }
    for (const g of sig.values()) if (g.length > 1) found.dup.push([g.join(', '), '', '']);
    for (const [id, g] of ids) if (g.length > 1) found.idDup.push([g.join(', '), idCol, id]);
    const emptyCols = cols.filter((c, j) => n > 0 && colBlank[j] === n);
    const mixed = cols.filter((c, j) => colNum[j] > 0 && colText[j] > 0 && Math.min(colNum[j], colText[j]) / (colNum[j] + colText[j]) < 0.5).map(c => { const j = cols.indexOf(c); return [`${colNum[j]} numbers, ${colText[j]} text`, c, '']; });
    const target = Number(String(p.target || '').replace(/[^\d.]/g, ''));
    const res = (id, label, count, status, advice, examples = []) => ({ id, label, count, status: count ? status : 'pass', advice, examples: examples.slice(0, 5) });
    return { checkedAt: now(), rows: n, columns: cols.length, results: [
      { id: 'STRUCTURE', label: 'File structure', count: 0, status: 'info', advice: `${n} data rows × ${cols.length} columns on sheet “${d.sheet}”, header row ${d.headerRow}. ${(d.allSheets || []).length > 1 ? (d.allSheets.length - 1) + ' other sheet(s) not used: ' + d.allSheets.filter(s => s.name !== d.sheet).map(s => s.name + (s.hidden ? ' (hidden)' : '')).join(', ') + '.' : 'Only one sheet.'}`, examples: [] },
      { id: 'SAMPLE', label: 'Rows received vs target sample', count: target && n !== target ? 1 : 0, status: 'warn', advice: target ? `Received ${n} rows; target is ${target}.` : `Received ${n} rows. No target sample entered in step 1.`, examples: [] },
      res('ID', 'Respondent ID present and unique', idCol ? found.idBlank.length + found.idDup.length : 1, 'fail', idCol ? `${found.idBlank.length} blank and ${found.idDup.length} repeated ID(s) in “${idCol}”.` : 'No respondent ID column chosen yet. Choose one in step 3.', [...found.idBlank, ...found.idDup]),
      res('EMPTY_ROWS', 'Empty rows', found.empty.length, 'warn', 'Rows with nothing in any column. Usually exported by mistake; the manager decides whether to exclude them.', found.empty),
      res('DUP_ROWS', 'Exact duplicate rows', found.dup.length, 'fail', 'Groups of rows that are identical in every column (possible double submission).', found.dup),
      res('SCI', 'Numbers damaged by Excel (scientific notation / over 15 digits)', found.sci.length, 'fail', 'Long IDs or phone numbers saved as numbers lose digits. Ask the vendor for a version with these columns saved as text.', found.sci),
      res('ERRORS', 'Spreadsheet errors (#N/A, #REF! …)', found.err.length, 'fail', 'Cells containing spreadsheet error values instead of answers.', found.err),
      res('FORMULAS', 'Formulas instead of typed values', found.formula.length, 'warn', 'The tool uses the value Excel last calculated but flags these cells for a decision.', found.formula),
      res('BAD_TEXT', 'Unreadable characters / encoding problems', found.bad.length, 'warn', 'Garbled text (e.g. Ã©, â€™, �) usually means the file was saved with a different text encoding. For CSV, try another encoding when importing.', found.bad),
      res('EMPTY_COLS', 'Empty columns', emptyCols.length, 'warn', 'Columns with no data at all. Check they are expected (e.g. a question nobody was routed to).', emptyCols.map(c => ['', c, ''])),
      res('MIXED', 'Columns mixing numbers and text', mixed.length, 'warn', 'A few text values in a numeric column (or the reverse) often means typing errors or unlabelled codes.', mixed),
      res('SPACES', 'Extra spaces before/after answers', found.spaces.length, 'warn', 'Can stop codes matching. Tick “Remove spaces” for those questions in step 3.', found.spaces),
      res('WS_ONLY', 'Cells containing only spaces', found.ws.length, 'warn', 'Look blank but are not empty. They are flagged as issues.', found.ws)
    ] };
  }
  function scanDataset(p, d) {
    const issues = [], idField = p.fields.find(f => f.id), ids = new Map(), signatures = new Map();
    for (const row of d.rows) {
      row.respondent = idField ? text(row.current[idField.name]) : '';
      if (row.excluded) continue;
      const std = standardRowChecks(p, d, row);
      for (const [field, code, msg] of std) pushIssue(issues, d, row, field, code, msg);
      if (std.some(x => x[1] === 'EMPTY_ROW')) { row.eligibility = null; continue; }
      if (idField && !missing(idField, row.current[idField.name])) {
        const id = text(row.current[idField.name]);
        if (!ids.has(id)) ids.set(id, []); ids.get(id).push(row);
      }
      if (p.duplicateRows) {
        const sig = stable(row.current); if (!signatures.has(sig)) signatures.set(sig, []); signatures.get(sig).push(row);
      }
      for (const f of p.fields) {
        const c = row.current[f.name] || cell(null);
        const path = condition(f.route, row.current, p.fields, new Set([f.name]));
        if (path === null) pushIssue(issues, d, row, f.name, 'ROUTE_UNKNOWN', 'Skip path cannot be determined from a missing or invalid upstream answer.');
        if (path === false) {
          if (!blank(c)) pushIssue(issues, d, row, f.name, 'SHOULD_SKIP', 'This question should have been skipped.');
        } else if (path === true && (f.required || f.id) && (f.id ? missing(f, c) : blank(c))) pushIssue(issues, d, row, f.name, 'REQUIRED', f.id ? 'Respondent ID is missing.' : 'Required answer is blank.');
        for (const [code, msg] of fieldErrors(f, c)) pushIssue(issues, d, row, f.name, code, msg);
      }
      // Unconfigured source columns are preserved and formula cells are still flagged.
      for (const name of d.outputColumns) if (!p.fields.some(f => f.name === name) && row.current[name]?.f) pushIssue(issues, d, row, name, 'FORMULA', 'Formula in an additional source column.');
      const eligible = condition(p.eligibility, row.current, p.fields);
      row.eligibility = p.eligibility ? eligible : null;
      if (p.eligibility && eligible !== true) pushIssue(issues, d, row, '', eligible === false ? 'INELIGIBLE' : 'ELIGIBILITY_UNKNOWN', eligible === false ? 'Respondent does not meet the approved eligibility condition.' : 'Eligibility cannot be determined.');
      for (const rule of p.checks) {
        const trigger = condition(rule.when, row.current, p.fields);
        if (trigger === null) pushIssue(issues, d, row, '', 'CHECK_UNKNOWN', 'Cross-check cannot be determined: ' + rule.message, rule.id);
        else if (trigger) {
          const result = condition(rule.expect, row.current, p.fields);
          if (result !== true) pushIssue(issues, d, row, '', result === null ? 'CHECK_UNKNOWN' : 'CONTRADICTION', rule.message, rule.id);
        }
      }
    }
    for (const rows of ids.values()) if (rows.length > 1) for (const r of rows) pushIssue(issues, d, r, idField.name, 'DUPLICATE_ID', 'Respondent ID occurs ' + rows.length + ' times.');
    for (const rows of signatures.values()) if (rows.length > 1) for (const r of rows) pushIssue(issues, d, r, '', 'DUPLICATE_ROW', 'Exact repeated response row.');
    const activeIds = new Set(issues.map(i => i.id));
    for (const old of d.issueLog) old.active = activeIds.has(old.id);
    const oldMap = new Map(d.issueLog.map(i => [i.id, i]));
    for (const issue of issues) {
      const old = oldMap.get(issue.id);
      if (old) { old.active = true; old.lastSeen = now(); }
      else d.issueLog.push({ ...issue, active: true, firstSeen: now(), lastSeen: now() });
    }
    d.scannedAt = now(); return issues;
  }
  function allIssues(p) {
    return p.datasets.flatMap(d => {
      const byIssue = new Map(d.decisions.map(x => [x.issueId, x]));
      return d.issueLog.filter(i => i.active).map(i => ({ ...i, decision: byIssue.get(i.id) || null }));
    });
  }
  function unresolved(p) { return allIssues(p).filter(i => !i.decision || i.decision.action !== 'retain'); }
  function count(p) {
    const rows = p.datasets.flatMap(d => d.rows), excluded = rows.filter(r => r.excluded).length;
    return { original: rows.length, excluded, included: rows.length - excluded, inspected: rows.filter(r => r.inspected).length, issues: allIssues(p).length,
      unresolved: unresolved(p).length, eligible: rows.filter(r => r.eligibility === true).length, ineligible: rows.filter(r => r.eligibility === false).length,
      eligibilityUnknown: rows.filter(r => r.eligibility === null || r.eligibility === undefined).length, changed: p.datasets.reduce((n, d) => n + d.changes.length, 0) };
  }
  function registerCleaner(p, actor) {
    if (!p.cleaners.some(n => normalName(n) === normalName(actor.name))) p.cleaners.push(actor.name);
  }
  function recordChange(p, d, r, field, after, actor, approval, reason) {
    const before = clone(r.current[field] || cell(null));
    if (stable(before) === stable(after)) return false;
    d.changes.push({ id: uid(), at: now(), rowKey: r.key, respondent: r.respondent, field, before, after: clone(after), reason, approval, operator: actor.name, revision: p.revision });
    r.current[field] = clone(after); r.inspected = null; registerCleaner(p, actor); return true;
  }
  function transformed(f, c) {
    if (blank(c) || c.f) return clone(c);
    let out = clone(c), v = value(out);
    if (f.trim && typeof v === 'string') { v = v.trim(); out = cell(v); }
    if (f.stringify && typeof v === 'number') { v = String(v); out = cell(v); }
    if (f.number && typeof v === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(v)) {
      const n = Number(v); if (Number.isFinite(n) && (!Number.isInteger(n) || Number.isSafeInteger(n))) { v = n; out = cell(v); }
    }
    const m = (f.mappings || []).find(x => String(x.from ?? '') === String(v));
    if (m) out = cell(m.to);
    return out;
  }
  async function checkRuleApproval(p) {
    assert(p.ruleApproval, 'The manager must approve the questionnaire and rules first.');
    assert(p.ruleApproval.digest === await hash(template(p)), 'Rules have changed. Ask the manager to approve this version again.');
    const errors = validateTemplate(p); assert(!errors.length, errors.join('\n'));
  }
  async function clean(p, actor, progress = () => {}, cancelled = () => false) {
    actorCheck(p, actor, ['cleaner']); await checkRuleApproval(p);
    // Stage all transformations so cancellation cannot leave a half-cleaned project.
    const staged = [], total = count(p).original; let done = 0;
    for (const d of p.datasets) for (const r of d.rows) {
      assert(!cancelled(), 'Cleaning cancelled. No changes were applied.');
      if (!r.excluded) {
        const prospective = clone(r.current);
        for (const f of p.fields) prospective[f.name] = transformed(f, prospective[f.name] || cell(null));
        // Clearing a skipped answer must itself have been explicitly approved.
        for (const f of p.fields) if (f.clearSkipped && condition(f.route, prospective, p.fields, new Set([f.name])) === false && !blank(prospective[f.name])) prospective[f.name] = cell(null);
        for (const name of d.outputColumns) if (stable(prospective[name]) !== stable(r.current[name])) staged.push({ d, r, name, after: prospective[name] });
      }
      done++; if (done % 100 === 0) { progress(done, total); await new Promise(resolve => setTimeout(resolve, 0)); }
    }
    assert(!cancelled(), 'Cleaning cancelled. No changes were applied.');
    if (staged.length) {
      invalidate(p, actor, 'Approved automatic corrections applied');
      for (const s of staged) recordChange(p, s.d, s.r, s.name, s.after, actor, p.ruleApproval.id, 'Approved template correction');
    }
    for (const d of p.datasets) { scanDataset(p, d); d.lastRunApproval = p.ruleApproval.digest; }
    audit(p, 'Whole-dataset check completed', actor, { changedCells: staged.length, counts: count(p), ruleApproval: p.ruleApproval.id });
    progress(total, total); return staged.length;
  }
  async function preview(p) {
    await checkRuleApproval(p);
    const result = [];
    for (const d of p.datasets) for (const r of d.rows) if (!r.excluded) {
      const after = clone(r.current);
      for (const f of p.fields) after[f.name] = transformed(f, after[f.name] || cell(null));
      for (const f of p.fields) if (f.clearSkipped && condition(f.route, after, p.fields, new Set([f.name])) === false && !blank(after[f.name])) after[f.name] = cell(null);
      for (const name of d.outputColumns) if (stable(after[name]) !== stable(r.current[name])) result.push({ file: d.name, row: r.sourceRow, field: name, before: r.current[name], after: after[name] });
    }
    return result;
  }
  function decide(p, issueId, decision, actor) {
    actorCheck(p, actor, ['manager']);
    const issue = allIssues(p).find(i => i.id === issueId); assert(issue, 'This issue is no longer active.');
    assert(['retain', 'correct', 'exclude'].includes(decision.action), 'Choose an issue decision.');
    assert(decision.reason?.trim(), 'Enter the decision reason.');
    const d = p.datasets.find(x => x.id === issue.datasetId);
    const field = issue.field || decision.field || '';
    if (decision.action === 'correct') {
      assert(field && d.outputColumns.includes(field), 'Choose which answer to correct.');
      assert(decision.evidence?.trim(), 'A correction needs verified evidence (for example a callback or vendor confirmation).');
      assert(String(decision.value ?? '').trim() !== '', 'Enter the corrected value. Missing answers must never be filled by assumption.');
    }
    invalidate(p, actor, 'Manager issue disposition recorded');
    const record = { id: uid(), issueId, rowKey: issue.rowKey, at: now(), by: actor.name, ...clone(decision), field, applied: false };
    d.decisions = d.decisions.filter(x => x.issueId !== issueId); d.decisions.push(record);
    audit(p, 'Manager issue decision', actor, { datasetId: d.id, issue: clone(issue), decision: record });
    return record;
  }
  function proposeCellIssue(p, datasetId, rowKey, field, actor) {
    actorCheck(p, actor, ['cleaner', 'manager']);
    const d = p.datasets.find(x => x.id === datasetId), r = d?.rows.find(x => x.key === rowKey);
    assert(r && d.outputColumns.includes(field), 'Select a valid response cell.');
    const tmp = []; pushIssue(tmp, d, r, field, 'MANUAL', 'Manual inspection: correction or disposition requested.');
    const issue = { ...tmp[0], active: true, firstSeen: now(), lastSeen: now(), manual: true };
    if (!d.issueLog.some(x => x.id === issue.id)) { invalidate(p, actor, 'Manual issue recorded'); d.issueLog.push(issue); audit(p, 'Manual issue recorded', actor, { issue }); }
    return issue.id;
  }
  function applyDecisions(p, actor) {
    actorCheck(p, actor, ['cleaner']);
    const pending = p.datasets.flatMap(d => d.decisions.filter(x => !x.applied && x.action !== 'retain').map(x => ({ d, x })));
    if (!pending.length) return 0;
    invalidate(p, actor, 'Approved case decisions applied'); registerCleaner(p, actor);
    for (const { d, x } of pending) {
      const row = d.rows.find(r => r.key === x.rowKey); assert(row, 'The approved source row is missing.');
      if (x.action === 'exclude') { row.excluded = { decision: x.id, reason: x.reason, by: x.by, appliedBy: actor.name, at: now() }; row.inspected = null; }
      else recordChange(p, d, row, x.field, typedValue(p.fields.find(f => f.name === x.field), x.value), actor, x.id, x.reason + ' | Evidence: ' + x.evidence);
      x.applied = true; audit(p, 'Approved case decision applied', actor, { datasetId: d.id, decision: x.id });
    }
    for (const d of p.datasets) scanDataset(p, d); return pending.length;
  }
  function typedValue(f, raw) {
    const s = String(raw ?? '');
    if (f && ['number', 'integer'].includes(f.type) && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s.trim())) return cell(Number(s.trim()));
    if (f && f.type === 'any' && /^[+-]?(?:0|[1-9]\d{0,14})(?:\.\d+)?$/.test(s.trim())) return cell(Number(s.trim()));
    return cell(s);
  }
  function inspectMany(p, rows, actor) {
    actorCheck(p, actor, ['cleaner']);
    const todo = [];
    for (const { datasetId, rowKey } of rows) {
      const row = p.datasets.find(d => d.id === datasetId)?.rows.find(r => r.key === rowKey);
      if (row && !row.inspected) todo.push(row);
    }
    if (!todo.length) return 0;
    invalidate(p, actor, 'Human inspection recorded'); registerCleaner(p, actor);
    const at = now();
    for (const row of todo) row.inspected = { by: actor.name, at, digestValues: stable(row.current), exclusion: stable(row.excluded) };
    audit(p, 'Respondents manually inspected', actor, { count: todo.length, rowKeys: todo.map(r => r.key) });
    return todo.length;
  }
  function removeDataset(p, datasetId, actor) {
    actorCheck(p, actor, ['cleaner', 'manager']);
    const d = p.datasets.find(x => x.id === datasetId); assert(d, 'Dataset not found.');
    assert(!d.changes.length && !d.decisions.length && !d.rows.some(r => r.excluded), 'This dataset already has changes or decisions and must be kept for the audit trail.');
    invalidate(p, actor, 'Dataset removed before cleaning');
    p.datasets = p.datasets.filter(x => x !== d);
    audit(p, 'Dataset registration removed before cleaning', actor, { datasetId: d.id, name: d.name, sourceHash: d.sourceHash });
  }
  // ---- Team accounts (passwords are salted PBKDF2 hashes kept in the project file) ----
  const hex = buf => Array.from(new Uint8Array(buf), v => v.toString(16).padStart(2, '0')).join('');
  async function passwordHash(pw, salt, iterations) {
    assert(globalThis.crypto?.subtle, 'This browser cannot do secure sign-in. Use a current version of Chrome or Edge.');
    const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
    const saltBytes = Uint8Array.from(salt.match(/../g).map(h => parseInt(h, 16)));
    return hex(await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, key, 256));
  }
  const account = (p, name) => (p.accounts || []).find(a => normalName(a.name) === normalName(name));
  function ensureAccounts(p) {
    if (!Array.isArray(p.accounts)) p.accounts = [];
    let added = 0;
    for (const name of Object.values(p.roles)) if (normalName(name) && !account(p, name)) { p.accounts.push({ id: uid(), name: name.trim(), hash: null, salt: null, iterations: 0, createdAt: now() }); added++; }
    return added;
  }
  function rolesOf(p, name) { return Object.keys(p.roles).filter(r => normalName(p.roles[r]) && normalName(p.roles[r]) === normalName(name)); }
  async function setPassword(p, name, pw, actorName) {
    const a = account(p, name); assert(a, 'Unknown person.');
    assert(!a.hash, 'A password is already set. Ask the DATA Team Manager to reset it.');
    assert(typeof pw === 'string' && pw.length >= 6, 'Use at least 6 characters.');
    a.salt = hex(globalThis.crypto.getRandomValues(new Uint8Array(16))); a.iterations = 150000;
    a.hash = await passwordHash(pw, a.salt, a.iterations); a.passwordSetAt = now();
    audit(p, 'Password set', { name: actorName || a.name, role: 'account' }, { account: a.name });
  }
  async function checkPassword(p, name, pw) {
    const a = account(p, name); assert(a, 'Unknown person.'); assert(a.hash, 'No password set yet.');
    return (await passwordHash(pw, a.salt, a.iterations)) === a.hash;
  }
  function addPerson(p, actor, name) {
    actorCheck(p, actor, ['manager']);
    name = String(name || '').trim(); assert(name && name.length <= 60, 'Enter a name.');
    assert(!account(p, name), 'That person is already in the team.');
    p.accounts.push({ id: uid(), name, hash: null, salt: null, iterations: 0, createdAt: now() });
    audit(p, 'Team member added', actor, { account: name });
  }
  function resetPassword(p, actor, name) {
    actorCheck(p, actor, ['manager']);
    const a = account(p, name); assert(a, 'Unknown person.');
    Object.assign(a, { hash: null, salt: null, iterations: 0, passwordSetAt: null });
    audit(p, 'Password reset by manager', actor, { account: a.name });
  }
  function setRoles(p, actor, roles, reason) {
    actorCheck(p, actor, ['manager']);
    for (const k of ['cleaner', 'reviewer', 'manager', 'releaser']) assert(account(p, roles[k]), 'Choose a person for every role.');
    assert(normalName(roles.reviewer) !== normalName(roles.cleaner), 'The reviewer must be a different person from the cleaner.');
    assert(!p.cleaners.some(n => normalName(n) === normalName(roles.reviewer)), roles.reviewer + ' has already cleaned this dataset and cannot be the reviewer.');
    assert(String(reason || '').trim(), 'Record the reason for the change (e.g. primary cleaner on leave).');
    const before = clone(p.roles);
    invalidate(p, actor, 'Role assignment changed');
    p.roles = { cleaner: account(p, roles.cleaner).name, reviewer: account(p, roles.reviewer).name, manager: account(p, roles.manager).name, releaser: account(p, roles.releaser).name };
    p.assignmentReason = reason;
    audit(p, 'Role assignment recorded', actor, { before, after: p.roles, reason });
  }
  function attachQre(p, qre, actor) {
    actorCheck(p, actor, ['cleaner', 'manager']);
    invalidate(p, actor, 'Questionnaire file attached', true);
    p.qre = { ...clone(qre), attachedAt: now(), by: actor.name };
    audit(p, 'Approved questionnaire attached', actor, { name: qre.name, hash: qre.hash, size: qre.size });
  }
  function markReleased(p, actor, destination, digest) {
    actorCheck(p, actor, ['releaser']);
    assert(p.approval && p.approval.digest === digest, 'Approval does not match this dataset.');
    p.released = { at: now(), by: actor.name, version: p.approval.version, destination, digest };
    audit(p, 'Release exported', actor, { version: p.approval.version, destination, digest });
  }
  function inspect(p, datasetId, rowKey, actor) {
    actorCheck(p, actor, ['cleaner']);
    const row = p.datasets.find(d => d.id === datasetId)?.rows.find(r => r.key === rowKey);
    assert(row, 'Respondent not found.');
    if (row.inspected) return;
    invalidate(p, actor, 'Human inspection recorded'); registerCleaner(p, actor);
    row.inspected = { by: actor.name, at: now(), digestValues: stable(row.current), exclusion: stable(row.excluded) };
    audit(p, 'Respondent manually inspected', actor, { rowKey });
  }
  async function snapshot(p) {
    return { projectId: p.id, name: p.name, mode: p.mode, target: p.target, source: p.source, vendor: p.vendor, moe: p.moe, moeBasis: p.moeBasis,
      roles: p.roles, cleaners: p.cleaners, ruleApproval: p.ruleApproval, template: template(p),
      datasets: p.datasets.map(d => ({ id: d.id, name: d.name, sourceHash: d.sourceHash, receiptAt: d.receiptAt, sheet: d.sheet, headerRow: d.headerRow,
        mapping: d.mapping, outputColumns: d.outputColumns, rows: d.rows.map(r => ({ key: r.key, original: r.original, current: r.current, excluded: r.excluded, inspected: r.inspected })),
        changes: d.changes, decisions: d.decisions, issueLog: d.issueLog.map(({ lastSeen, ...issue }) => issue) })) };
  }
  async function snapshotHash(p) { return hash(await snapshot(p)); }
  function gates(p) {
    const c = count(p), out = [];
    if (!p.ruleApproval) out.push('Manager approval of questionnaire and rules');
    if (!p.datasets.length || !c.original) out.push('At least one respondent dataset');
    if (p.datasets.some(d => d.lastRunApproval !== p.ruleApproval?.digest)) out.push('Run checks using the current approved rules');
    if (!p.moeBasis.trim()) out.push('Sample-design / margin-of-error basis');
    if (!Object.values(p.roles).every(x => normalName(x))) out.push('Assigned cleaner, reviewer, manager and releasing analyst');
    if (normalName(p.roles.reviewer) === normalName(p.roles.cleaner) || p.cleaners.some(n => normalName(n) === normalName(p.roles.reviewer))) out.push('A reviewer who did not clean this dataset');
    if (c.unresolved) out.push(c.unresolved + ' unresolved issue(s) or unapplied decisions');
    if (c.inspected !== c.original) out.push((c.original - c.inspected) + ' respondent(s) awaiting human inspection');
    if (c.original !== c.excluded + c.included) out.push('Sample count reconciliation');
    if (p.datasets.some(d => d.rows.some(r => r.inspected && (r.inspected.digestValues !== stable(r.current) || r.inspected.exclusion !== stable(r.excluded))))) out.push('Repeat inspection of changed records');
    return out;
  }
  async function verify(p, actor, passed, note, checklist) {
    actorCheck(p, actor, ['reviewer']);
    assert(!p.cleaners.some(n => normalName(n) === normalName(actor.name)) && normalName(actor.name) !== normalName(p.roles.cleaner), 'A cleaner cannot independently verify the same dataset.');
    assert(note.trim(), 'Record the verification outcome and findings.');
    if (passed) {
      await checkRuleApproval(p); assert(!gates(p).length, gates(p).join('\n'));
      assert(checklist?.length === 5 && checklist.every(Boolean), 'Complete all five independent review checks.');
    }
    const attempt = { id: uid(), at: now(), by: actor.name, passed, note, checklist, digest: await snapshotHash(p), revision: p.revision };
    p.verification = passed ? attempt : null; p.approval = null; p.released = null;
    audit(p, passed ? 'Independent verification passed' : 'Independent verification failed; return to cleaning', actor, attempt);
    return attempt;
  }
  async function approveRelease(p, actor, approved, note, version) {
    actorCheck(p, actor, ['manager']); assert(note.trim(), 'Record the approval or rejection reason.');
    if (approved) {
      await checkRuleApproval(p); assert(!gates(p).length, gates(p).join('\n'));
      assert(p.verification?.passed && p.verification.digest === await snapshotHash(p), 'A passed independent verification of this exact version is required.');
      assert(/^[A-Za-z0-9._-]{1,30}$/.test(version), 'Use a release version such as v001 (letters, numbers, dots, underscores or hyphens).');
      assert(!p.history.some(h => h.event === 'Release exported' && h.version === version), 'This version has already been released. Choose a new version.');
      p.approval = { id: uid(), at: now(), by: actor.name, note, version, digest: p.verification.digest, verification: p.verification.id };
      audit(p, 'Manager release approval', actor, p.approval);
    } else { invalidate(p, actor, 'Manager rejected release: ' + note); audit(p, 'Manager rejected release; return to cleaning', actor, { note }); }
  }
  async function releaseCheck(p, actor) {
    actorCheck(p, actor, ['releaser']); await checkRuleApproval(p);
    assert(!gates(p).length, gates(p).join('\n'));
    const digest = await snapshotHash(p);
    assert(p.verification?.passed && p.verification.digest === digest && p.approval?.digest === digest, 'This exact dataset needs passed independent verification and manager approval.');
    return digest;
  }
  function stage(p) {
    if (p.released) return 'RELEASED'; if (p.approval) return 'APPROVED'; if (p.verification) return 'VERIFIED';
    if (!gates(p).length) return 'READY FOR REVIEW'; if (p.datasets.length && p.ruleApproval) return 'CLEANING'; if (p.ruleApproval) return 'RULES CONFIRMED'; return 'SETUP';
  }
  function assertProject(p) {
    assert(p?.schema === 1 && p.appVersion && typeof p.id === 'string' && Array.isArray(p.datasets) && Array.isArray(p.fields) && Array.isArray(p.history), 'This is not a supported Local Survey Cleaner project.');
    assert(p.roles && ['cleaner','reviewer','manager','releaser'].every(k => typeof p.roles[k] === 'string'), 'Project role records are invalid.');
    assert(p.fields.length <= 500 && p.datasets.length <= 50, 'Project exceeds supported limits.');
    assert(Array.isArray(p.checks) && Array.isArray(p.cleaners), 'Project rules/history are invalid.');
    assert(p.accounts === undefined || (Array.isArray(p.accounts) && p.accounts.length <= 100 && p.accounts.every(a => a && typeof a.name === 'string' && a.name.trim())), 'Team accounts are invalid.');
    for (const f of p.fields) assert(typeof f.name === 'string' && !unsafe(f.name) && Array.isArray(f.allowed) && Array.isArray(f.missing) && Array.isArray(f.mappings), 'Invalid field configuration.');
    const rowKeys = new Set();
    for (const d of p.datasets) {
      assert(Array.isArray(d.rows) && d.rows.length <= 10000 && Array.isArray(d.outputColumns) && d.outputColumns.length <= 500 && Array.isArray(d.issueLog) && Array.isArray(d.decisions) && Array.isArray(d.changes), 'Invalid dataset structure or limits.');
      for (const r of d.rows) {
        assert(r.key && !rowKeys.has(r.key) && r.original && r.current, 'Invalid or repeated source row key.'); rowKeys.add(r.key);
        for (const group of [r.original,r.current]) for (const [key,c] of Object.entries(group)) assert(!unsafe(key) && c && ['z','s','n','b','d','e'].includes(c.t) && (c.v === null || ['string','number','boolean'].includes(typeof c.v)), 'Invalid response value in saved project.');
      }
    }
  }
  const api = { VERSION, clone, now, uid, normalName, value, blank, text, cell, stable, hash, assert, unsafe, actorCheck, audit, invalidate, createProject, defaultField,
    template, validateTemplate, updateProject, updateRules, approveRules, fieldErrors, missing, condition, scanDataset, allIssues, unresolved, count, registerCleaner,
    clean, preview, decide, proposeCellIssue, applyDecisions, inspect, inspectMany, attachQre, removeDataset, rawHealth, standardRowChecks, ensureAccounts, rolesOf, account, setPassword, checkPassword, addPerson, resetPassword, setRoles, markReleased, typedValue, sha256js, snapshot, snapshotHash, gates, verify, approveRelease, releaseCheck, stage, assertProject, checkRuleApproval };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SurveyEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
