/* Local Survey Cleaner: screens. Everything runs in this browser tab. */
(function () {
  'use strict';
  const E = window.SurveyEngine, IO = window.SurveyIO;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = iso => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };
  const show = c => { if (!c || c.v === null || c.v === undefined || c.v === '') return ''; return c.date && c.t === 'n' ? c.date : String(c.v); };
  const showCell = c => {
    if (!c || c.v === null || c.v === '') return '<span class="empty">blank</span>';
    const s = show(c);
    return (s.trim() === '' ? '<span class="empty">spaces only</span>' : esc(s.length > 120 ? s.slice(0, 117) + '…' : s)) + (c.f ? ' <span class="tag warn">formula</span>' : '');
  };
  const plural = (n, a, b) => n + ' ' + (n === 1 ? a : (b || a + 's'));
  const PAGE = 50;

  const ROLES = {
    cleaner: { label: 'Data cleaner', short: 'Cleaner' },
    reviewer: { label: 'Independent reviewer', short: 'Reviewer' },
    manager: { label: 'DATA Team Manager', short: 'Manager' },
    releaser: { label: 'Releasing analyst', short: 'Releaser' }
  };
  const STEPS = [
    { n: 1, title: 'Project & questionnaire', who: 'Cleaner', sop: 'SOP Step 1' },
    { n: 2, title: 'Receive data', who: 'Cleaner', sop: 'SOP Step 2' },
    { n: 3, title: 'Cleaning rules', who: 'Cleaner, then Manager approves', sop: 'SOP Step 1' },
    { n: 4, title: 'Check, fix & inspect', who: 'Cleaner + Manager decisions', sop: 'SOP Steps 3–4' },
    { n: 5, title: 'Independent review', who: 'Reviewer', sop: 'SOP Step 5' },
    { n: 6, title: 'Manager approval', who: 'Manager', sop: 'SOP Step 6' },
    { n: 7, title: 'Release', who: 'Releasing analyst', sop: 'SOP Step 7' }
  ];
  const PROBLEMS = {
    REQUIRED: 'Required answer missing', CODE: 'Answer not in code list', RANGE: 'Out of range', TYPE: 'Wrong type or format',
    SHOULD_SKIP: 'Answered but should be skipped', ROUTE_UNKNOWN: 'Route unclear (earlier answer missing/invalid)', DUPLICATE_ID: 'Repeated respondent ID',
    DUPLICATE_ROW: 'Exact duplicate row', INELIGIBLE: 'Not eligible', ELIGIBILITY_UNKNOWN: 'Eligibility unclear', CONTRADICTION: 'Contradictory answers',
    CHECK_UNKNOWN: 'Cross-check unclear', FORMULA: 'Formula in cell', CELL_ERROR: 'Spreadsheet error value', WHITESPACE: 'Spaces only',
    MULTI_DUPLICATE: 'Selection repeated', EXCLUSIVE: 'Exclusive choice with others', SELECTION_COUNT: 'Wrong number of selections', MANUAL: 'Flagged during inspection',
    EMPTY_ROW: 'Empty row', MOSTLY_BLANK: 'Mostly blank respondent', STRAIGHTLINE: 'Same answer to every question', BAD_TEXT: 'Unreadable characters', SCI_NOTATION: 'Number damaged by Excel',
    DERIVED: 'No band or label for an added column'
  };
  const DERIVED_KINDS = { band: 'Bands', label: 'Labels', combine: 'Combine' };
  const OPS = [['eq', 'equals'], ['neq', 'does not equal'], ['in', 'is one of'], ['notin', 'is not one of'], ['gt', 'is greater than'], ['gte', 'is at least'], ['lt', 'is less than'], ['lte', 'is at most'], ['answered', 'is answered'], ['blank', 'is blank']];
  const TYPES = [['any', 'Any / codes'], ['text', 'Text'], ['number', 'Number'], ['integer', 'Whole number'], ['date', 'Date'], ['multi', 'Multiple choice']];
  const ACTIONS = { retain: 'Retain and flag', correct: 'Correct from evidence', exclude: 'Exclude respondent' };

  let P = null, role = null, user = null;
  const ui = { step: 1, dirty: false, tab: 'issues', pending: null, queue: [], draft: null, draftDirty: false, digest: null,
    issues: { status: 'open', code: '', field: '', q: '', page: 0, sel: new Set() }, resp: { filter: 'todo', q: '', page: 0 }, changesPage: 0, cancel: false };

  const actor = () => ({ role, name: user || '' });
  const myRoles = () => (P && user ? E.rolesOf(P, user) : []);
  const initials = n => String(n).trim().split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
  const roleNames = rs => rs.map(r => ROLES[r].short).join(' + ');
  const ds = id => P.datasets.find(d => d.id === id);
  const rowOf = (dId, key) => ds(dId)?.rows.find(r => r.key === key);

  // ---------- generic helpers ----------
  function toast(msg, kind = 'ok') {
    const t = $('#toast'); t.className = 'show ' + kind; t.innerHTML = esc(msg).replace(/\n/g, '<br>');
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, kind === 'error' ? 9000 : 3800);
  }
  function download(bytes, name, type = 'application/octet-stream') {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function busy(msg) {
    const b = $('#busy');
    if (msg === false) { b.hidden = true; return; }
    b.hidden = false; b.querySelector('.msg').textContent = msg; b.querySelector('.bar i').style.width = '0%'; b.querySelector('button').hidden = true;
  }
  function progress(done, total) { $('#busy .bar i').style.width = Math.round(100 * done / Math.max(1, total)) + '%'; }
  async function refreshDigest() { ui.digest = P ? await E.hash(E.template(P)) : null; }
  const rulesApproved = () => !!(P.ruleApproval && P.ruleApproval.digest === ui.digest);
  async function run(fn, { mutate = true, msg } = {}) {
    try {
      if (msg) busy(msg);
      const out = await fn();
      if (mutate && P) { ui.dirty = true; await refreshDigest(); }
      return out;
    } catch (e) { toast(e.message || String(e), 'error'); console.error(e); }
    finally { if (msg) busy(false); render(); }
  }
  function openModal(html, wide) {
    const m = $('#modal'); m.className = wide ? 'wide' : ''; m.innerHTML = html;
    if (!m.open) m.showModal();
    const f = m.querySelector('[autofocus]'); if (f) f.focus();
  }
  function closeModal() { const m = $('#modal'); if (m.open) m.close(); m.innerHTML = ''; }
  function confirmBox(title, body, okLabel, onOk, danger) {
    ui.onConfirm = onOk;
    openModal(`<h2 id="modal-title">${esc(title)}</h2><div class="modal-body">${body}</div>
      <div class="actions"><button data-act="closeModal" class="ghost">Cancel</button><button data-act="confirmOk" class="${danger ? 'danger' : 'primary'}">${esc(okLabel)}</button></div>`);
  }
  function pickFile(id) { const i = $(id); i.value = ''; i.click(); }
  const val = id => { const el = document.getElementById(id); return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined; };
  function canAct(roles) { return roles.includes(role); }
  function roleHint(roles, what) {
    if (canAct(roles)) return '';
    const names = roles.map(r => `<b>${esc(P.roles[r] || ROLES[r].label)}</b> (${ROLES[r].short})`).join(' or ');
    return `<p class="hint lock">🔒 Only ${names} can ${esc(what)}.${myRoles().length > 1 ? ' If that is one of your roles, switch role at the top.' : ' They need to sign in to do this.'}</p>`;
  }
  function pager(total, page, act) {
    const pages = Math.ceil(total / PAGE); if (pages <= 1) return '';
    return `<div class="pager"><button class="ghost small" data-act="${act}" data-page="${page - 1}" ${page <= 0 ? 'disabled' : ''}>← Previous</button>
      <span>Page ${page + 1} of ${pages}</span><button class="ghost small" data-act="${act}" data-page="${page + 1}" ${page >= pages - 1 ? 'disabled' : ''}>Next →</button></div>`;
  }

  // ---------- progress / next action ----------
  function status() {
    const c = E.count(P), issues = E.allIssues(P);
    const needDecision = issues.filter(i => !i.decision).length;
    const toApply = P.datasets.reduce((n, d) => n + d.decisions.filter(x => !x.applied && x.action !== 'retain').length, 0);
    const checksCurrent = P.datasets.length > 0 && P.datasets.every(d => d.lastRunApproval && d.lastRunApproval === P.ruleApproval?.digest);
    const step1 = !!(P.name.trim() && P.name !== 'Untitled project' && P.qre && P.qreVersion.trim() && Object.values(P.roles).every(x => x.trim()) && P.moeBasis.trim());
    return { c, issues, needDecision, toApply, checksCurrent, step1, gates: E.gates(P) };
  }
  function nextAction(s) {
    if (!s.step1) return { step: 1, who: 'cleaner', text: 'Fill in the project details and people, record the margin-of-error basis, and attach the approved questionnaire.' };
    if (!P.datasets.length) return { step: 2, who: 'cleaner', text: 'Add the survey data file you received.' };
    if (!P.fields.length) return { step: 3, who: 'cleaner', text: 'Set up the cleaning rules for each question.' };
    if (!rulesApproved()) return P.ruleApproval || ui.draftDirty
      ? { step: 3, who: 'manager', text: 'The rules changed. The manager needs to approve them again.' }
      : { step: 3, who: 'manager', text: 'Check the cleaning rules match the questionnaire, then the manager approves them.' };
    if (!s.checksCurrent) return { step: 4, who: 'cleaner', text: 'Run the checks on all respondents.' };
    if (s.needDecision) return { step: 4, who: 'manager', text: `The manager decides what to do about ${plural(s.needDecision, 'issue')}.` };
    if (s.toApply) return { step: 4, who: 'cleaner', text: `Apply ${plural(s.toApply, 'approved decision')} to the data.` };
    if (s.c.inspected < s.c.original) return { step: 4, who: 'cleaner', text: `Inspect the remaining ${plural(s.c.original - s.c.inspected, 'respondent')} and mark them inspected.` };
    if (s.gates.length) return { step: 4, who: 'cleaner', text: 'Resolve: ' + s.gates[0] + '.' };
    if (!P.verification) return { step: 5, who: 'reviewer', text: 'The independent reviewer checks the cleaned data and records pass or fail.' };
    if (!P.approval) return { step: 6, who: 'manager', text: 'The manager approves this exact verified version for release.' };
    if (!P.released) return { step: 7, who: 'releaser', text: 'Create the release: download the approved Excel and release package.' };
    return { step: 7, who: null, text: `Released as ${P.released.version}. The dataset is ready for BDR, A&R and VS reporting.` };
  }
  function stepDone(n, s) {
    switch (n) {
      case 1: return s.step1;
      case 2: return P.datasets.length > 0;
      case 3: return rulesApproved();
      case 4: return rulesApproved() && s.checksCurrent && !s.gates.length;
      case 5: return !!P.verification;
      case 6: return !!P.approval;
      case 7: return !!P.released;
    }
  }

  // ---------- render ----------
  function render() {
    const app = $('#app');
    if (!P) { app.innerHTML = ui.guide ? guideView() : ui.setup ? setupView() : homeView(); return; }
    if (!user) { app.innerHTML = loginView(); const f = document.querySelector('#app [autofocus]'); if (f) f.focus(); return; }
    const s = status(), next = nextAction(s);
    const stage = E.stage(P);
    const nav = STEPS.map(st => `<button class="step ${ui.step === st.n ? 'on' : ''} ${stepDone(st.n, s) ? 'done' : ''}" data-act="go" data-step="${st.n}">
      <span class="num">${stepDone(st.n, s) ? '✓' : st.n}</span><span><b>${esc(st.title)}</b><small>${esc(st.who)}</small></span></button>`).join('');
    const mine = myRoles();
    const roleCtl = mine.length > 1 ? `<select id="role" aria-label="Your role">${mine.map(r => `<option value="${r}" ${r === role ? 'selected' : ''}>${ROLES[r].label}</option>`).join('')}</select>`
      : `<span class="rolebadge">${mine.length ? ROLES[mine[0]].label : 'View only (no role)'}</span>`;
    const nextWho = next.who ? `<span class="who">${esc(P.roles[next.who] || ROLES[next.who].label)} · ${ROLES[next.who].short}</span>` : '';
    const isMe = next.who && E.normalName(P.roles[next.who]) === E.normalName(user);
    const switchBtn = !next.who ? '' : isMe ? (next.who !== role ? `<button class="small ghost" data-act="becomeRole" data-role="${next.who}">Switch to my ${ROLES[next.who].short} role</button>` : '')
      : `<span class="waiting">Waiting for ${esc(P.roles[next.who] || ROLES[next.who].label)}. Save and send them the project, or sign out so they can sign in here.</span><button class="small ghost" data-act="signOut">Sign out</button>`;
    app.innerHTML = `
      <header class="top">
        <div class="brandmark"><span class="logo" aria-hidden="true"></span><div><b class="wm">ENDEAVOUR DATA</b><small>survey cleaner</small></div></div>
        <div class="brand"><b>${esc(P.name)}</b><small>${P.demo ? '<span class="tag demo">DEMO</span> ' : ''}<span class="stage">${esc(stage)}</span></small></div>
        <div class="as"><span class="avatar">${esc(initials(user))}</span><div><b>${esc(user)}</b>${roleCtl}</div></div>
        <div class="filebtns">
          <button class="primary" data-act="saveProject">${ui.dirty ? '<span class="dot" title="Unsaved changes"></span>' : ''}Save project</button>
          <button class="ghost" data-act="guide">Guide</button>
          <button class="ghost" data-act="signOut">Sign out</button>
          <button class="ghost" data-act="closeProject">Close</button>
        </div>
      </header>
      ${ui.dirty ? '<div class="unsaved">You have unsaved changes. Click <b>Save project</b> to keep a copy on this computer. Nothing is saved automatically.</div>' : ''}
      <div class="layout">
        <nav class="steps" aria-label="Steps">${nav}<p class="side-note">Nothing is saved automatically. Use Save project.</p></nav>
        <main>
          <section class="next ${next.who && !isMe ? 'other' : ''}"><div><small>NEXT STEP</small><p>${esc(next.text)}</p>${nextWho}</div>
            <div class="row">${switchBtn}${ui.step !== next.step ? `<button class="small" data-act="go" data-step="${next.step}">Go to step ${next.step}</button>` : ''}</div></section>
          <p class="eyebrow">Step ${ui.step} of 7 · ${esc(STEPS[ui.step - 1].sop)} · ${esc(STEPS[ui.step - 1].who)}</p>
          ${[step1, step2, step3, step4, step5, step6, step7][ui.step - 1](s)}
        </main>
      </div>`;
  }

  const brandBar = () => `<div class="home-top"><div class="brandmark"><span class="logo" aria-hidden="true"></span><div><b class="wm">ENDEAVOUR DATA</b><small>survey cleaner</small></div></div><span class="ver">DATA SOP 03 · v${esc(E.VERSION)}</span></div>`;
  const guideHtml = () => document.getElementById('guide-tpl')?.innerHTML || '<p>The guide is missing from this copy of the app.</p>';
  function guideView() {
    return `${brandBar()}<div class="home guide-page"><button class="ghost small" data-act="closeGuide">← Back to start</button><div class="guide">${guideHtml()}</div>
      <p><button class="ghost small" data-act="closeGuide">← Back to start</button></p></div>`;
  }
  function homeView() {
    return `${brandBar()}<div class="home">
      <h1>Survey Cleaner</h1>
      <p class="lead">Check, clean, verify and release survey datasets under DATA SOP 03.</p>
      <div class="start">
        <button class="primary big" data-act="newProject">Start a new project</button>
        <button class="outline big" data-act="openProject">Open a saved project</button>
        <button class="ghost big" data-act="guide">How to use (guide)</button>
      </div>
      <div class="homegrid">
        <section class="card"><h2>Process</h2>
          <ol class="proc">${STEPS.map(s => `<li><span class="pn">${s.n}</span><b>${esc(s.title)}</b><span class="pw">${esc(s.who)}</span></li>`).join('')}</ol></section>
        <section class="card"><h2>Before you start</h2>
          <p><b>Accounts.</b> Each project has its own team. Whoever creates the project names the manager, cleaner, reviewer and releasing analyst. Everyone else creates their password the first time they sign in.</p>
          <p><b>Saving.</b> Nothing is saved automatically. Click <b>Save project</b> to download a .zip of the work. To continue later, or to hand over to the reviewer or manager, open that .zip with <b>Open a saved project</b>.</p>
          <p><b>New to this?</b> Read <button class="link" data-act="guide">How to use</button>: a short step-by-step guide with screenshots and examples. It is also under <b>Guide</b> at the top of every project.</p></section>
      </div>
    </div>`;
  }

  // ---------- new project set-up & sign-in ----------
  function setupView() {
    const v = ui.setupVals || (ui.setupVals = { name: '', manager: '', cleaner: '', reviewer: '', releaser: '', me: 'manager' });
    return `${brandBar()}<div class="home narrow"><p class="eyebrow">Set-up</p><h1>New project</h1>
      <p class="lead">Name the project and its team. Each person signs in with their own password and can only do their own steps. The manager can change roles later.</p>
      <div class="card"><label class="f"><span>Project name</span><input id="su_name" value="${esc(v.name)}" placeholder="e.g. PKR26 Melaka Wave 1" autofocus></label>
        <h3>Team</h3><div class="grid2">${Object.keys(ROLES).map(r => `<label class="f"><span>${ROLES[r].label}</span><input id="su_${r}" value="${esc(v[r])}" placeholder="Full name"></label>`).join('')}</div>
        <p class="hint">One person may hold several roles (e.g. the cleaner can also release), but the reviewer must be someone other than the cleaner. Enter the primary cleaner here; the manager can switch to the backup cleaner later.</p>
        <h3>You</h3><div class="grid3">
          <label class="f"><span>I am the</span><select id="su_me">${Object.keys(ROLES).map(r => `<option value="${r}" ${v.me === r ? 'selected' : ''}>${ROLES[r].label}</option>`).join('')}</select></label>
          <label class="f"><span>Create your password</span><input id="su_pw" type="password" autocomplete="new-password"></label>
          <label class="f"><span>Repeat password</span><input id="su_pw2" type="password" autocomplete="new-password"></label></div>
        <p class="hint">At least 6 characters. Everyone else creates their own password the first time they sign in.</p></div>
      <div class="actions"><button class="ghost" data-act="cancelSetup">Cancel</button><button class="primary" data-act="createProject">Create project</button></div></div>`;
  }
  async function createProject() {
    const v = { name: val('su_name').trim(), me: val('su_me') };
    for (const r of Object.keys(ROLES)) v[r] = val('su_' + r).trim().replace(/\s+/g, ' ');
    ui.setupVals = v;
    const pw = val('su_pw') || '', pw2 = val('su_pw2') || '';
    if (!v.name) return toast('Enter a project name.', 'error');
    if (Object.keys(ROLES).some(r => !v[r])) return toast('Enter a name for every role.', 'error');
    if (E.normalName(v.reviewer) === E.normalName(v.cleaner)) return toast('The reviewer must be a different person from the cleaner.', 'error');
    if (pw.length < 6) return toast('Use a password of at least 6 characters.', 'error');
    if (pw !== pw2) return toast('The two passwords do not match.', 'error');
    await run(async () => {
      const p = E.createProject(); p.name = v.name;
      p.roles = { cleaner: v.cleaner, reviewer: v.reviewer, manager: v.manager, releaser: v.releaser };
      E.ensureAccounts(p);
      const me = E.account(p, v[v.me]).name;
      await E.setPassword(p, me, pw);
      E.audit(p, 'Project and team created', { role: v.me, name: me }, { roles: p.roles });
      P = p; user = me; role = v.me; ui.setup = false; ui.setupVals = null; ui.step = 1; ui.draft = null; ui.pending = null; ui.queue = [];
      toast('Project created. You are signed in as ' + me + '.');
    }, { msg: 'Creating project…' });
  }
  function loginView() {
    const sel = ui.loginAs, acc = sel && E.account(P, sel);
    const list = P.accounts.map(a => { const rs = E.rolesOf(P, a.name); return `<button class="person ${acc && acc.id === a.id ? 'on' : ''}" data-act="pickLogin" data-name="${esc(a.name)}">
      <span class="avatar">${esc(initials(a.name))}</span><span><b>${esc(a.name)}</b><small>${rs.length ? esc(rs.map(r => ROLES[r].label).join(', ')) : 'No role'}${a.hash ? '' : ' · first sign-in'}</small></span></button>`; }).join('');
    const form = !acc ? '<p class="muted">Choose your name.</p>' : acc.hash
      ? `<label class="f"><span>Password for ${esc(acc.name)}</span><input id="li_pw" type="password" autocomplete="current-password" autofocus></label>
        <div class="actions"><button class="primary" data-act="signIn">Sign in</button></div><p class="hint">Forgot your password? The DATA Team Manager can reset it.</p>`
      : `<p><b>First sign-in for ${esc(acc.name)}.</b> Create your password (at least 6 characters).</p><div class="grid2">
        <label class="f"><span>New password</span><input id="li_pw" type="password" autocomplete="new-password" autofocus></label>
        <label class="f"><span>Repeat password</span><input id="li_pw2" type="password" autocomplete="new-password"></label></div>
        <div class="actions"><button class="primary" data-act="signIn">Create password & sign in</button></div>`;
    return `${brandBar()}<div class="home narrow"><div class="hero small"><p class="eyebrow">Sign in</p><h1>${esc(P.name)}</h1>
      <p>Stage: <b>${esc(E.stage(P))}</b>. Sign in to continue.</p>${P.demo ? '<p class="demo-hint">Demo: every password is <code>demo1234</code>. Start as <b>Demo Cleaner</b>.</p>' : ''}</div>
      <div class="card"><h2>Who are you?</h2><div class="people">${list}</div>${form}</div>
      <div class="actions"><button class="ghost" data-act="closeProject">Close project</button></div></div>`;
  }
  async function signIn() {
    const acc = E.account(P, ui.loginAs); if (!acc) return;
    const pw = val('li_pw') || '';
    await run(async () => {
      if (!acc.hash) {
        if (pw !== (val('li_pw2') || '')) throw Error('The two passwords do not match.');
        await E.setPassword(P, acc.name, pw); ui.dirty = true;
      } else if (!(await E.checkPassword(P, acc.name, pw))) throw Error('Wrong password. Try again, or ask the DATA Team Manager to reset it.');
      user = acc.name; ui.loginAs = null;
      const mine = E.rolesOf(P, user), next = nextAction(status());
      role = next.who && mine.includes(next.who) ? next.who : mine[0] || null;
      if (next.who && mine.includes(next.who)) ui.step = next.step;
      toast(`Signed in as ${user}${mine.length ? ' (' + roleNames(mine) + ')' : '. You have no role in this project, so you can only view it.'}`);
    }, { mutate: false, msg: 'Signing in…' });
  }
  function signOut() { user = null; role = null; ui.loginAs = null; ui.issues.sel.clear(); closeModal(); window.scrollTo(0, 0); render(); }

  // ---------- step 1 ----------
  function step1() {
    const r = P.roles, can = canAct(['cleaner', 'manager']), dis = can ? '' : 'disabled';
    const field = (id, label, value, help = '', type = 'text') => `<label class="f"><span>${label}</span><input id="${id}" type="${type}" value="${esc(value)}" ${dis}>${help ? `<small>${help}</small>` : ''}</label>`;
    return `<h1>Project & questionnaire</h1>
      <p class="lead">Record the project and the people involved, then attach the approved questionnaire (QRE) and its version.</p>
      ${roleHint(['cleaner', 'manager'], 'change these details')}
      <div class="card"><h2>Project</h2><div class="grid2">
        ${field('p_name', 'Project name', P.name === 'Untitled project' ? '' : P.name)}
        <label class="f"><span>Survey mode</span><select id="p_mode" ${dis}>${['CATI', 'FtF', 'Online', 'Mixed', 'Other'].map(m => `<option ${P.mode === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        ${field('p_target', 'Target sample', P.target, 'Number of completed interviews planned.')}
        ${field('p_source', 'Data source / vendor', P.source)}
      </div></div>
${teamCard()}
      <div class="card"><h2>Sample design & margin of error</h2>
        <p class="hint">SOP 2.3: confirm with the manager. Do not give a conventional margin of error unless the sample design supports it.</p>
        <div class="grid2">
          ${field('p_moe', 'Margin of error', P.moe, 'For example “±4.4% at 95%” or “Not applicable”.')}
          ${field('p_moeBasis', 'Basis, as confirmed with the manager', P.moeBasis, 'For example: “Quota sample — MoE not applicable (confirmed by manager 12 Nov)”.')}
        </div></div>
      <div class="card"><h2>Approved questionnaire (QRE)</h2>
        <div class="grid2">
          <div class="f"><span>QRE file</span>${P.qre ? `<div class="filechip">📄 ${esc(P.qre.name)} <small>${(P.qre.size / 1024).toFixed(0)} KB · checksum ${esc(P.qre.hash.slice(0, 12))}…</small></div>` : '<div class="empty">No file attached yet</div>'}
            <button class="ghost small" data-act="attachQre" ${dis}>${P.qre ? 'Replace file' : 'Attach QRE file'}</button></div>
          ${field('p_qreVersion', 'QRE version / date', P.qreVersion, 'For example “v3 — 8 Nov 2026”. The manager confirms this when approving the rules.')}
        </div></div>
      <div class="actions"><button class="primary" data-act="saveStep1" ${dis}>Save details</button></div>`;
  }
  function teamCard() {
    const isMgr = canAct(['manager']);
    const opts = cur => P.accounts.map(a => `<option ${E.normalName(a.name) === E.normalName(cur) ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
    const people = P.accounts.map(a => {
      const rs = E.rolesOf(P, a.name);
      return `<tr><td><b>${esc(a.name)}</b>${E.normalName(a.name) === E.normalName(user) ? ' <span class="tag ok">you</span>' : ''}</td><td>${rs.length ? esc(rs.map(r => ROLES[r].label).join(', ')) : '<span class="muted">No role</span>'}</td>
        <td>${a.hash ? '✓ Password set' : '<span class="tag warn">Sets password at first sign-in</span>'}</td>
        <td>${isMgr && a.hash && E.normalName(a.name) !== E.normalName(user) ? `<button class="small ghost" data-act="resetPw" data-name="${esc(a.name)}">Reset password</button>` : ''}</td></tr>`;
    }).join('');
    return `<div class="card"><h2>Team & roles</h2>
      <p class="hint">SOP 03: the manager assigns the roles. The reviewer must <b>not</b> be anyone who cleaned the data. If the backup cleaner takes over and was the reviewer, choose a different reviewer.</p>
      <div class="tablewrap short"><table><thead><tr><th>Person</th><th>Roles</th><th>Sign-in</th><th></th></tr></thead><tbody>${people}</tbody></table></div>
      ${isMgr ? `<h3>Assign roles</h3><div class="grid2">
        ${Object.keys(ROLES).map(r => `<label class="f"><span>${ROLES[r].label}</span><select id="ro_${r}">${opts(P.roles[r])}</select></label>`).join('')}</div>
        <label class="f"><span>Reason for change (required when changing roles)</span><input id="ro_reason" placeholder="e.g. Primary cleaner on leave; manager reassigned cleaning to the backup cleaner"></label>
        <div class="row"><button class="small" data-act="saveRoles">Save role changes</button><span class="spacer"></span>
          <input id="newPerson" placeholder="New person's name" class="inline"><button class="small ghost" data-act="addPerson">Add person</button></div>`
        : roleHint(['manager'], 'change the team or roles')}
      ${P.assignmentReason ? `<p class="hint">Last reassignment: ${esc(P.assignmentReason)}</p>` : ''}</div>`;
  }
  function saveStep1() {
    const changes = { name: val('p_name').trim() || 'Untitled project', mode: val('p_mode'), target: val('p_target').trim(), source: val('p_source').trim(),
      moe: val('p_moe').trim(), moeBasis: val('p_moeBasis').trim(), qreVersion: val('p_qreVersion').trim(), assignmentReason: '' };
    delete changes.assignmentReason;
    const diff = Object.fromEntries(Object.entries(changes).filter(([k, v]) => P[k] !== v));
    if (!Object.keys(diff).length) { toast('No changes to save.'); return; }
    return run(() => { E.updateProject(P, diff, actor()); toast('Details saved.'); });
  }

  // ---------- step 2 ----------
  function step2(s) {
    const can = canAct(['cleaner']);
    const list = P.datasets.map(d => `<tr><td>📊 ${esc(d.name)}</td><td>${esc(d.sheet)}</td><td>${d.rows.length}</td><td>${fmtDate(d.receiptAt)}</td><td>${esc(d.vendor || '')}</td>
      <td><code>${esc(d.sourceHash.slice(0, 10))}</code></td><td>${can && !d.changes.length && !d.decisions.length ? `<button class="small ghost" data-act="removeDataset" data-id="${d.id}">Remove</button>` : ''}</td></tr>`).join('');
    const c = s.c;
    return `<h1>Receive data</h1>
      <p class="lead">Add the survey data file. The original file is kept unchanged as <b>ORIGINAL</b>, and all cleaning happens on a separate working copy.</p>
      ${roleHint(['cleaner'], 'add data files')}
      ${ui.pending ? pendingCard() : `<div class="drop ${can ? '' : 'off'}" id="drop" ${can ? 'data-act="chooseData" tabindex="0" role="button"' : ''}>
        <b>Drop survey files here</b> or click to choose<small>Excel (.xlsx, .xls), OpenDocument (.ods), CSV, tab-separated (.tsv, .txt) or flat JSON · up to 25 MB and 10,000 respondents per file</small></div>`}
      ${P.datasets.map(d => healthCard(d)).join('')}
      ${P.datasets.length ? `<div class="card"><h2>Datasets received</h2><div class="tablewrap"><table><thead><tr><th>File</th><th>Sheet</th><th>Rows</th><th>Received</th><th>Vendor comments</th><th>Checksum</th><th></th></tr></thead><tbody>${list}</tbody></table></div></div>` : ''}
      <div class="card"><h2>Sample summary</h2><div class="tiles">
        ${tile('Target', P.target || '—')}${tile('Received', c.original)}${tile('Eligible', P.eligibility ? c.eligible : '—', P.eligibility ? '' : 'No eligibility rule yet')}
        ${tile('Excluded', c.excluded)}${tile('Final included', c.included)}${tile('Margin of error', P.moe || '—', P.moeBasis ? '' : 'Basis not recorded')}
      </div><p class="hint">Check: received (${c.original}) = excluded (${c.excluded}) + included (${c.included}) ${c.original === c.excluded + c.included ? '✓' : '✗'}</p></div>`;
  }
  const healthCache = new Map();
  function health(d) {
    const key = d.id + '|' + (P.fields.find(f => f.id)?.name || '') + '|' + P.target;
    if (!healthCache.has(key)) healthCache.set(key, E.rawHealth(P, d));
    return healthCache.get(key);
  }
  const ICON = { pass: '<span class="st pass" title="Passed">✓</span>', warn: '<span class="st warn" title="Check">!</span>', fail: '<span class="st fail" title="Problem">✗</span>', info: '<span class="st info" title="Information">i</span>' };
  function healthCard(d, compact) {
    const h = health(d), probs = h.results.filter(r => r.status === 'fail' || r.status === 'warn').filter(r => r.count);
    const fails = h.results.filter(r => r.status === 'fail' && r.count).length, warns = h.results.filter(r => r.status === 'warn' && r.count).length;
    const rows = h.results.filter(r => !compact || r.count || r.status === 'info').map(r => `<tr class="${r.count && r.status !== 'info' ? r.status : ''}"><td>${ICON[r.count || r.status === 'info' ? r.status : 'pass']}</td><td><b>${esc(r.label)}</b><small class="sub">${esc(r.advice)}</small>
      ${r.examples.length && r.count ? `<small class="sub ex">e.g. ${r.examples.map(e => esc([e[0] && 'row ' + e[0], e[1], e[2] && '“' + e[2] + '”'].filter(Boolean).join(' '))).join(' · ')}</small>` : ''}</td><td class="c">${r.status === 'info' ? '' : r.count}</td></tr>`).join('');
    return `<div class="card ${fails ? 'failcard' : warns ? '' : 'okcard'}"><h2>Standard raw-data checks · ${esc(d.name)}</h2>
      <p class="hint">The same ${h.results.length - 2} checks run on every file as soon as it arrives, before any questionnaire rules. Result: <b>${fails ? plural(fails, 'problem') : 'no problems'}</b>, <b>${plural(warns, 'warning')}</b>. Problems in individual respondents also appear in step 4 for a manager decision.</p>
      <div class="tablewrap ${compact ? 'short' : ''}"><table class="health"><thead><tr><th></th><th>Check</th><th class="c">Found</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${probs.some(r => r.id === 'BAD_TEXT') && /\.(csv|tsv|txt)$/i.test(d.name) ? '<p class="hint">Tip: remove this file and add it again with a different text encoding.</p>' : ''}</div>`;
  }
  const tile = (label, value, sub = '') => `<div class="tile"><small>${esc(label)}</small><b>${esc(value)}</b>${sub ? `<em>${esc(sub)}</em>` : ''}</div>`;
  function pendingCard() {
    const pd = ui.pending, input = pd.input, table = input.tables[pd.table];
    let columns = [], err = '';
    try { columns = IO.columnsAt(table, pd.header); } catch (e) { err = e.message; }
    const preview = table.cells.slice(pd.header - 1, pd.header + 5);
    const width = Math.min(12, Math.max(0, ...preview.map(r => r.length)));
    const isText = /\.(csv|tsv|txt)$/i.test(input.name);
    const sheets = input.tables.map((t, i) => `<option value="${i}" ${i === pd.table ? 'selected' : ''}>${esc(t.name)}${t.hidden ? ' (hidden)' : ''} — ${t.cells.length} rows</option>`).join('');
    let mapping = '';
    if (P.fields.length && columns.length) {
      mapping = `<h3>Match questions to columns</h3><p class="hint">Your rules list ${P.fields.length} questions. Each must match a column in this file. Matches by name are filled in automatically.</p>
        <div class="tablewrap short"><table><thead><tr><th>Question (rules)</th><th>Column in this file</th></tr></thead><tbody>${P.fields.map(f => {
          const cur = pd.mapping[f.name] ?? '';
          return `<tr class="${cur ? '' : 'bad'}"><td>${esc(f.name)}</td><td><select data-map="${esc(f.name)}"><option value="">— choose —</option>${columns.map(c => `<option ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></td></tr>`;
        }).join('')}</tbody></table></div>`;
    }
    return `<div class="card pending"><h2>Set up: ${esc(input.name)}</h2>
      ${ui.queue.length ? `<p class="hint">${plural(ui.queue.length, 'more file')} waiting after this one.</p>` : ''}
      <div class="grid3">
        <label class="f"><span>Worksheet / table</span><select id="pd_table">${sheets}</select>${input.tables.length > 1 ? '<small>Only the selected sheet is used. Other sheets are listed in the receipt log.</small>' : ''}</label>
        <label class="f"><span>Header row (column names)</span><input id="pd_header" type="number" min="1" value="${pd.header}"></label>
        ${isText ? `<label class="f"><span>Separator</span><select id="pd_delim">${[['', 'Automatic'], [',', 'Comma'], [';', 'Semicolon'], ['tab', 'Tab'], ['|', 'Pipe']].map(([v, l]) => `<option value="${v}" ${pd.settings.delimiter === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="f"><span>Text encoding</span><select id="pd_enc">${[['utf-8', 'UTF-8 (standard)'], ['windows-1252', 'Windows Western'], ['utf-16le', 'UTF-16']].map(([v, l]) => `<option value="${v}" ${pd.settings.encoding === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
      </div>
      ${err ? `<p class="error">${esc(err)}</p>` : `<p class="hint">${plural(table.cells.length - pd.header, 'respondent row')} and ${plural(columns.length, 'column')} found. Preview:</p>`}
      <div class="tablewrap short"><table class="preview">${preview.map((r, i) => `<tr class="${i === 0 ? 'head' : ''}">${Array.from({ length: width }, (_, j) => `<td>${showCell(r[j])}</td>`).join('')}${(r.length > width) ? '<td>…</td>' : ''}</tr>`).join('')}</table></div>
      ${mapping}
      <h3>Receipt details</h3><div class="grid3">
        <label class="f"><span>Received date & time</span><input id="pd_at" type="datetime-local" value="${esc(pd.receivedAt)}"></label>
        <label class="f"><span>Source / vendor</span><input id="pd_source" value="${esc(pd.source)}"></label>
        <label class="f"><span>Vendor comments</span><input id="pd_vendor" value="${esc(pd.vendor)}"></label>
      </div>
      <div class="actions"><button class="ghost" data-act="cancelPending">Cancel</button><button class="primary" data-act="registerPending" ${err ? 'disabled' : ''}>Register this dataset</button></div></div>`;
  }
  function localNow() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
  async function readPending(file, settings = {}) {
    const input = await IO.readInput(file, { delimiter: settings.delimiter || undefined, encoding: settings.encoding || 'utf-8' });
    let table = Math.max(0, input.tables.findIndex(t => t.cells.length && !t.hidden));
    const header = Math.max(1, input.tables[table].cells.findIndex(r => r.filter(c => c.v !== null && c.v !== '').length >= 2) + 1);
    ui.pending = { file, input, table, header, settings: { delimiter: settings.delimiter || '', encoding: settings.encoding || 'utf-8' }, mapping: {}, receivedAt: localNow(), source: P.source || '', vendor: '' };
    autoMap();
  }
  function autoMap() {
    const pd = ui.pending; let columns = [];
    try { columns = IO.columnsAt(pd.input.tables[pd.table], pd.header); } catch { return; }
    const norm = x => String(x).trim().toLowerCase().replace(/[\s_-]+/g, '');
    pd.mapping = {};
    for (const f of P.fields) { const m = columns.find(c => c === f.name) || columns.find(c => norm(c) === norm(f.name)); if (m) pd.mapping[f.name] = m; }
  }
  async function takeFiles(files) {
    if (!P) return;
    if (!canAct(['cleaner'])) return toast('Switch to the data cleaner to add data files.', 'error');
    const list = [...files]; if (!list.length) return;
    ui.step = 2; ui.queue.push(...list.slice(ui.pending ? 0 : 1));
    if (!ui.pending) await run(() => readPending(list[0]), { mutate: false, msg: 'Reading ' + list[0].name + '…' });
    else render();
  }
  async function nextQueued() {
    ui.pending = null;
    const f = ui.queue.shift();
    if (f) await run(() => readPending(f), { mutate: false, msg: 'Reading ' + f.name + '…' }); else render();
  }
  function registerPending() {
    const pd = ui.pending;
    pd.receivedAt = val('pd_at'); pd.source = val('pd_source'); pd.vendor = val('pd_vendor');
    return run(async () => {
      const at = pd.receivedAt ? new Date(pd.receivedAt).toISOString() : E.now();
      const d = IO.importDataset(P, pd.input, pd.table, pd.header, { ...pd.mapping }, actor(), { receivedAt: at, source: pd.source, vendor: pd.vendor });
      ui.draft = null;
      toast(`Registered ${d.name}: ${plural(d.rows.length, 'respondent')}. Original kept unchanged.`);
      await nextQueued();
    });
  }

  // ---------- step 3: rules ----------
  function draft() { if (!ui.draft) { ui.draft = E.clone({ fields: P.fields, checks: P.checks, eligibility: P.eligibility, duplicateRows: P.duplicateRows, derived: P.derived || [], respNumber: !!P.respNumber }); ui.draftDirty = false; } return ui.draft; }
  function condText(c) {
    if (!c) return '';
    if (c.conditions) return c.conditions.map(condText).join(c.logic === 'all' ? ' and ' : ' or ');
    const op = OPS.find(o => o[0] === c.op)?.[1] || c.op;
    return `${c.field} ${op}${['answered', 'blank'].includes(c.op) ? '' : ' ' + String(c.value ?? '').split('|').join(', ')}`;
  }
  function step3() {
    const dr = draft(), can = canAct(['cleaner', 'manager']), dis = can ? '' : 'disabled';
    const errors = E.validateTemplate({ ...P, ...dr });
    const approved = rulesApproved();
    if (!dr.fields.length) return `<h1>Cleaning rules</h1><p class="lead">The rules describe the questionnaire: allowed answer codes, required questions and skip logic.</p>
      <div class="card empty-state"><p>No questions yet. <b>Add a data file in step 2</b> and its columns become the list of questions, or load a rules template saved from an earlier project.</p>
      <div class="row"><button data-act="go" data-step="2">Go to step 2</button><button class="ghost" data-act="loadTemplate" ${dis}>Load rules template</button></div></div>`;
    const rows = dr.fields.map((f, i) => `<tr>
      <td class="c"><input type="radio" name="idfield" data-fi="${i}" data-k="id" ${f.id ? 'checked' : ''} ${dis} title="Respondent ID column"></td>
      <td><b>${esc(f.name)}</b>${f.label ? `<small class="sub">${esc(f.label)}</small>` : ''}</td>
      <td><select data-fi="${i}" data-k="type" ${dis}>${TYPES.map(([v, l]) => `<option value="${v}" ${f.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td class="c"><input type="checkbox" data-fi="${i}" data-k="required" ${f.required ? 'checked' : ''} ${dis}></td>
      <td><input data-fi="${i}" data-k="allowed" value="${esc(f.allowed.join(', '))}" placeholder="any" ${dis}></td>
      <td><input data-fi="${i}" data-k="missing" value="${esc(f.missing.join(', '))}" placeholder="none" class="narrow" ${dis}></td>
      <td><input data-fi="${i}" data-k="min" value="${f.min ?? ''}" class="tiny" ${dis}></td>
      <td><input data-fi="${i}" data-k="max" value="${f.max ?? ''}" class="tiny" ${dis}></td>
      <td class="route">${f.route ? esc(condText(f.route)) : '<span class="muted">always</span>'}</td>
      <td>${fieldExtras(f)}<button class="small ghost" data-act="editField" data-fi="${i}">${can ? 'Edit' : 'View'}</button></td></tr>`).join('');
    const checks = dr.checks.map((c, i) => `<li><span>If <b>${esc(condText(c.when))}</b> then <b>${esc(condText(c.expect))}</b><small>${esc(c.message)}</small></span>
      ${can ? `<span class="row"><button class="small ghost" data-act="editCheck" data-ci="${i}">Edit</button><button class="small ghost" data-act="delCheck" data-ci="${i}">Remove</button></span>` : ''}</li>`).join('');
    return `<h1>Cleaning rules</h1>
      <p class="lead">Describe the questionnaire once: the respondent ID, answer codes, required questions and when each question is asked. The app only checks and corrects what these rules say. Save them as a template to reuse for the next wave.</p>
      ${roleHint(['cleaner', 'manager'], 'edit the rules')}
      <div class="row toolbar">
        <button class="ghost small" data-act="loadTemplate" ${dis}>Load rules template…</button>
        <button class="ghost small" data-act="saveTemplateJson">Save rules template</button>
        <button class="ghost small" data-act="templateXlsx">Download rules as Excel</button>
        <span class="muted">Large questionnaire? Download as Excel, fill in the codes there, then load it back.</span>
      </div>
      <div class="card"><h2>Questions <small>(${dr.fields.length})</small></h2>
        <p class="hint">Codes: separate with commas, e.g. <code>1, 2, 3</code>. <b>Missing codes</b> are refusal or don't-know codes (e.g. <code>98, 99</code>). They are accepted as answers and are not checked against the code list or range. <b>Required</b> flags blank answers for respondents who were asked the question. <b>ID</b> = the respondent ID column.</p>
        <div class="tablewrap rules"><table><thead><tr><th>ID</th><th>Question / column</th><th>Type</th><th>Required</th><th>Allowed codes</th><th>Missing codes</th><th>Min</th><th>Max</th><th>Asked when</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>
      <div class="grid2">
        <div class="card"><h2>Eligibility</h2><p class="hint">Who counts as an eligible respondent (screening). Leave empty if everyone is eligible.</p>
          <p>${dr.eligibility ? `<b>${esc(condText(dr.eligibility))}</b>` : '<span class="muted">Everyone is eligible</span>'}</p>
          <button class="small ghost" data-act="editElig" ${dis}>${dr.eligibility ? 'Change' : 'Add eligibility rule'}</button></div>
        <div class="card"><h2>Standard checks (always on)</h2><p class="hint">Every file is also checked for: empty rows, repeated IDs, duplicate rows, numbers damaged by Excel, spreadsheet errors, formulas, unreadable characters, spaces-only cells, mostly blank respondents and straight-lining. Nothing is ever removed automatically.</p></div>
      </div>
      <div class="card"><h2>Cross-question checks</h2><p class="hint">Catch contradictions, e.g. “If Q5 (owns car) = 2 (No) then Q6 (car brand) is blank”.</p>
        ${checks ? `<ul class="checks">${checks}</ul>` : '<p class="muted">None yet.</p>'}
        <button class="small ghost" data-act="editCheck" data-ci="-1" ${dis}>Add a check</button></div>
      <div class="card"><h2>Added columns</h2><p class="hint">New columns calculated from the answers and added to the cleaned data, e.g. age bands, English labels or a quota segment. The original columns are never changed. A value that does not fit is left blank and flagged for the manager.</p>
        <label class="check"><input type="checkbox" id="dv_resp" ${dr.respNumber ? 'checked' : ''} ${dis}> Add <b>${esc(E.RESP_COL)}</b> as the first column: each respondent's row number in the raw file, so every row can be traced back.</label>
        ${dr.derived.length ? `<ul class="checks">${dr.derived.map((d, i) => `<li><span><b>${esc(d.name)}</b> <span class="tag">${esc(DERIVED_KINDS[d.kind] || d.kind)}</span><small>${esc(derivedText(d))}</small></span>
          <span class="row"><button class="small ghost" data-act="editDerived" data-di="${i}">${can ? 'Edit' : 'View'}</button>${can ? `<button class="small ghost" data-act="delDerived" data-di="${i}">Remove</button>` : ''}</span></li>`).join('')}</ul>` : '<p class="muted">No added columns yet.</p>'}
        <button class="small ghost" data-act="editDerived" data-di="-1" ${dis}>+ Add column</button></div>
      <div class="savebar" id="savebar" ${ui.draftDirty ? '' : 'hidden'}><span>You have unsaved rule changes.</span><button class="ghost" data-act="discardRules">Discard</button><button class="primary" data-act="saveRules" ${dis}>Save rules</button></div>
      <div class="card ${approved ? 'okcard' : 'warncard'}"><h2>Manager approval of rules</h2>
        ${errors.length ? `<div class="error"><b>Fix before approval:</b><ul>${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
        ${approved ? `<p>✓ Approved by <b>${esc(P.ruleApproval.by)}</b> on ${fmtDate(P.ruleApproval.at)} for QRE <b>${esc(P.ruleApproval.qreVersion)}</b>.<br><small>${esc(P.ruleApproval.note)}</small></p>`
          : `<p>${P.ruleApproval ? 'The rules have changed since they were approved, so they need approval again.' : 'Not approved yet.'} The manager confirms that the QRE version is <b>${esc(P.qreVersion || '(not entered)')}</b> and that these rules match it.</p>
          ${roleHint(['manager'], 'approve the rules')}
          ${canAct(['manager']) ? `<label class="f"><span>Approval note</span><input id="ruleNote" placeholder="e.g. Checked against QRE v3; routing for Q7–Q9 confirmed"></label>
          <div class="actions"><button class="primary" id="approveBtn" data-act="approveRules" ${errors.length || ui.draftDirty ? 'disabled' : ''}>Approve questionnaire & rules</button></div>${ui.draftDirty ? '<p class="hint">Save the rule changes first.</p>' : ''}` : ''}`}
      </div>`;
  }
  function fieldExtras(f) {
    const tags = [];
    if (f.mappings.length) tags.push(plural(f.mappings.length, 'recode'));
    if (f.trim) tags.push('trim');
    if (f.number) tags.push('→number');
    if (f.stringify) tags.push('→text');
    if (f.clearSkipped) tags.push('clear if skipped');
    if (f.type === 'multi') tags.push('sep “' + f.delimiter + '”');
    return tags.map(t => `<span class="tag">${esc(t)}</span>`).join(' ');
  }
  function onRuleInput(el) {
    const dr = draft(), f = dr.fields[+el.dataset.fi], k = el.dataset.k;
    if (k === 'id') dr.fields.forEach((x, i) => { x.id = i === +el.dataset.fi; if (x.id) x.route = null; });
    else if (k === 'required') f.required = el.checked;
    else if (k === 'type') f.type = el.value;
    else if (k === 'allowed' || k === 'missing') f[k] = IO.splitCodes(el.value);
    else if (k === 'min' || k === 'max') { const v = el.value.trim(); f[k] = v === '' ? null : Number(v); if (v !== '' && !Number.isFinite(f[k])) { toast('Enter a number for ' + k + '.', 'error'); f[k] = null; el.value = ''; } }
    markDraft();
  }
  function markDraft() {
    ui.draftDirty = true;
    const bar = $('#savebar'); if (bar) bar.hidden = false;
    const btn = $('#approveBtn'); if (btn) btn.disabled = true;
  }

  // condition builder (one level: all / any)
  function builder(id, c, fields) {
    const list = !c ? [] : c.conditions ? c.conditions : [c];
    const logic = c?.conditions ? c.logic : 'all';
    const rowsHtml = (list.length ? list : [{ field: '', op: 'eq', value: '' }]).map(x => condRow(x, fields)).join('');
    return `<div class="builder" id="${id}"><div class="logic">Match <select class="b-logic"><option value="all" ${logic === 'all' ? 'selected' : ''}>all of these</option><option value="any" ${logic === 'any' ? 'selected' : ''}>any of these</option></select></div>
      <div class="b-rows">${rowsHtml}</div><button class="small ghost" data-act="addCond" data-b="${id}">+ Add condition</button></div>`;
  }
  function condRow(x, fields) {
    return `<div class="b-row"><select class="b-field"><option value="">— question —</option>${fields.map(f => `<option ${f.name === x.field ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
      <select class="b-op">${OPS.map(([v, l]) => `<option value="${v}" ${x.op === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input class="b-val" value="${esc(String(x.value ?? '').split('|').join(', '))}" placeholder="value(s)">
      <button class="small ghost" data-act="delCond" title="Remove">✕</button></div>`;
  }
  function readBuilder(id) {
    const b = document.getElementById(id); if (!b) return null;
    const conds = [...b.querySelectorAll('.b-row')].map(r => {
      const op = r.querySelector('.b-op').value, raw = r.querySelector('.b-val').value;
      const parts = IO.splitCodes(raw);
      return { field: r.querySelector('.b-field').value, op, value: ['in', 'notin'].includes(op) ? parts.join('|') : raw.trim() };
    }).filter(x => x.field);
    for (const c of conds) if (!['answered', 'blank'].includes(c.op) && c.value === '') throw Error(`Enter a value for “${c.field}”.`);
    if (!conds.length) return null;
    return conds.length === 1 ? conds[0] : { logic: b.querySelector('.b-logic').value, conditions: conds };
  }
  function editField(i) {
    const dr = draft(), f = dr.fields[i], can = canAct(['cleaner', 'manager']);
    const others = dr.fields.filter(x => x.name !== f.name);
    const recodes = f.mappings.map(m => recodeRow(m)).join('');
    openModal(`<h2 id="modal-title">Question: ${esc(f.name)}</h2><div class="modal-body">
      <div class="grid2"><label class="f"><span>Label / question wording (optional)</span><input id="fm_label" value="${esc(f.label)}"></label>
        <label class="f"><span>Type</span><select id="fm_type">${TYPES.map(([v, l]) => `<option value="${v}" ${f.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
      <h3>Asked when (skip logic)</h3>
      <label class="check"><input type="checkbox" id="fm_always" ${f.route ? '' : 'checked'}> Asked to everyone</label>
      <div id="fm_routewrap" ${f.route ? '' : 'hidden'}><p class="hint">Only respondents who match these conditions should answer this question. Everyone else should leave it blank.</p>${builder('fm_route', f.route, others)}
        <label class="check"><input type="checkbox" id="fm_clear" ${f.clearSkipped ? 'checked' : ''}> Automatically clear answers given by respondents who should have skipped it <small>(only if the manager approves this as a standing rule)</small></label></div>
      <h3>Multiple choice</h3>
      <div class="grid3"><label class="f"><span>Separator between choices</span><input id="fm_delim" value="${esc(f.delimiter)}" maxlength="1" class="tiny"></label>
        <label class="f"><span>Min choices</span><input id="fm_mins" value="${f.minSelections ?? ''}" class="tiny"></label>
        <label class="f"><span>Max choices</span><input id="fm_maxs" value="${f.maxSelections ?? ''}" class="tiny"></label></div>
      <label class="f"><span>Exclusive codes (e.g. “None of the above”)</span><input id="fm_excl" value="${esc(f.exclusive.join(', '))}"></label>
      <h3>Approved automatic corrections</h3>
      <label class="check"><input type="checkbox" id="fm_trim" ${f.trim ? 'checked' : ''}> Remove spaces before/after the answer</label>
      <label class="check"><input type="checkbox" id="fm_number" ${f.number ? 'checked' : ''}> Convert numbers stored as text into numbers</label>
      <label class="check"><input type="checkbox" id="fm_text" ${f.stringify ? 'checked' : ''}> Store as text (keeps leading zeros, e.g. IDs and phone numbers)</label>
      <p class="hint">Recodes: replace one exact value with another, e.g. <code>Yes</code> → <code>1</code>. Blank answers can never be recoded.</p>
      <div id="fm_recodes">${recodes}</div><button class="small ghost" data-act="addRecode">+ Add recode</button>
      </div><div class="actions"><button class="ghost" data-act="closeModal">${can ? 'Cancel' : 'Close'}</button>${can ? `<button class="primary" data-act="saveField" data-fi="${i}">Done</button>` : ''}</div>`, true);
  }
  const recodeRow = m => `<div class="b-row recode"><input class="rc-from" value="${esc(m.from ?? '')}" placeholder="from"> → <input class="rc-to" value="${esc(m.to ?? '')}" placeholder="to"><button class="small ghost" data-act="delCond">✕</button></div>`;
  const typed = s => /^[+-]?(?:0|[1-9]\d{0,14})(?:\.\d+)?$/.test(s.trim()) ? Number(s.trim()) : s;
  function saveField(i) {
    const f = draft().fields[i];
    try {
      const route = val('fm_always') ? null : readBuilder('fm_route');
      if (!val('fm_always') && !route) throw Error('Add at least one condition, or tick “Asked to everyone”.');
      const num = (id, label) => { const v = val(id).trim(); if (v === '') return null; const n = Number(v); if (!Number.isInteger(n) || n < 0) throw Error(label + ' must be a whole number.'); return n; };
      const mappings = [...document.querySelectorAll('#fm_recodes .recode')].map(r => ({ from: r.querySelector('.rc-from').value.trim(), to: r.querySelector('.rc-to').value.trim() })).filter(m => m.from !== '' || m.to !== '');
      if (mappings.some(m => m.from === '')) throw Error('Each recode needs a “from” value.');
      const toText = val('fm_text');
      Object.assign(f, { label: val('fm_label').trim(), type: val('fm_type'), route, clearSkipped: !!route && val('fm_clear'), delimiter: val('fm_delim') || ';',
        minSelections: num('fm_mins', 'Min choices'), maxSelections: num('fm_maxs', 'Max choices'), exclusive: IO.splitCodes(val('fm_excl')),
        trim: val('fm_trim'), number: val('fm_number'), stringify: toText,
        mappings: mappings.map(m => ({ from: m.from, to: toText || f.type === 'text' ? m.to : typed(m.to) })) });
      if (f.id) f.route = null;
      closeModal(); ui.draftDirty = true; render();
    } catch (e) { toast(e.message, 'error'); }
  }
  function editCheck(i) {
    const dr = draft(), c = i >= 0 ? dr.checks[i] : { message: '', when: null, expect: null };
    openModal(`<h2 id="modal-title">${i >= 0 ? 'Edit' : 'Add'} cross-question check</h2><div class="modal-body">
      <label class="f"><span>Description shown on the issue</span><input id="ck_msg" value="${esc(c.message)}" placeholder="e.g. Non-car owners should not name a car brand" autofocus></label>
      <h3>If…</h3>${builder('ck_when', c.when, dr.fields)}
      <h3>…then this must be true</h3>${builder('ck_expect', c.expect, dr.fields)}</div>
      <div class="actions"><button class="ghost" data-act="closeModal">Cancel</button><button class="primary" data-act="saveCheck" data-ci="${i}">Done</button></div>`, true);
  }
  function saveCheck(i) {
    try {
      const msg = val('ck_msg').trim(), when = readBuilder('ck_when'), expect = readBuilder('ck_expect');
      if (!msg || !when || !expect) throw Error('Enter a description and both the “If” and “then” conditions.');
      const dr = draft(), rec = { id: i >= 0 ? dr.checks[i].id : 'CHK-' + E.uid().slice(0, 8), message: msg, when, expect };
      if (i >= 0) dr.checks[i] = rec; else dr.checks.push(rec);
      closeModal(); ui.draftDirty = true; render();
    } catch (e) { toast(e.message, 'error'); }
  }
  function editElig() {
    const dr = draft();
    openModal(`<h2 id="modal-title">Eligibility rule</h2><div class="modal-body"><p class="hint">Respondents who do not match are flagged as “Not eligible”. The manager decides whether to exclude them.</p>
      ${builder('el_b', dr.eligibility, dr.fields)}</div>
      <div class="actions"><button class="ghost" data-act="clearElig">Everyone is eligible</button><button class="ghost" data-act="closeModal">Cancel</button><button class="primary" data-act="saveElig">Done</button></div>`, true);
  }

  // added columns (derived)
  function derivedText(d) {
    if (d.kind === 'band') return 'Bands of ' + d.source + ': ' + d.bands.map(E.bandLabel).join(' · ');
    if (d.kind === 'label') { const l = d.labels.map(x => x.from + ' → ' + x.to); return 'Labels of ' + d.source + ': ' + l.slice(0, 6).join(' · ') + (l.length > 6 ? ' …' : ''); }
    return 'Combines ' + d.parts.join(' ' + d.sep + ' ');
  }
  const pickOpts = (list, sel) => '<option value="">— choose —</option>' + list.map(n => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const bandRow = b => `<div class="b-row band"><input class="bd-min" value="${esc(b.min ?? '')}" placeholder="from"> to <input class="bd-max" value="${esc(b.max ?? '')}" placeholder="and over"> = <input class="bd-label" value="${esc(b.label ?? '')}" placeholder="label (optional)"><button class="small ghost" data-act="delCond" title="Remove">✕</button></div>`;
  const labelRow = m => `<div class="b-row label"><input class="lb-from" value="${esc(m.from ?? '')}" placeholder="code"> = <input class="lb-to" value="${esc(m.to ?? '')}" placeholder="label, e.g. Malay"><button class="small ghost" data-act="delCond" title="Remove">✕</button></div>`;
  const partRow = sel => `<div class="b-row part"><select class="pt">${pickOpts(ui.dvParts || [], sel)}</select><button class="small ghost" data-act="delCond" title="Remove">✕</button></div>`;
  function editDerived(i) {
    const dr = draft(), can = canAct(['cleaner', 'manager']);
    const d = i >= 0 ? dr.derived[i] : { name: '', kind: 'band', source: '', sep: '|' };
    ui.dvParts = [...dr.fields.map(f => f.name), ...dr.derived.slice(0, i >= 0 ? i : dr.derived.length).map(x => x.name)];
    const k = d.kind;
    openModal(`<h2 id="modal-title">${i >= 0 ? (can ? 'Edit' : 'View') : 'Add'} column</h2><div class="modal-body">
      <div class="grid2"><label class="f"><span>New column name</span><input id="dv_name" value="${esc(d.name)}" placeholder="e.g. AGE_BAND"></label>
        <label class="f"><span>What it does</span><select id="dv_kind">
          <option value="band" ${k === 'band' ? 'selected' : ''}>Group numbers into bands (e.g. age bands)</option>
          <option value="label" ${k === 'label' ? 'selected' : ''}>Turn codes into labels (e.g. 1 = Malay)</option>
          <option value="combine" ${k === 'combine' ? 'selected' : ''}>Join columns into one key (e.g. a quota segment)</option></select></label></div>
      <div id="dv_srcwrap" ${k === 'combine' ? 'hidden' : ''}><label class="f"><span>Calculated from question</span><select id="dv_src">${pickOpts(dr.fields.map(f => f.name), d.source)}</select></label></div>
      <div id="dv_band" ${k === 'band' ? '' : 'hidden'}>
        <p class="hint">One row per band. Both ends are included: <code>18 to 29</code> includes 18 and 29. Leave the last “to” empty for “and over”. Leave the label empty to show e.g. <code>18-29</code> or <code>60+</code>.</p>
        <div id="dv_bands">${(d.bands?.length ? d.bands : [{}]).map(bandRow).join('')}</div><button class="small ghost" data-act="addBand">+ Add band</button></div>
      <div id="dv_label" ${k === 'label' ? '' : 'hidden'}>
        <p class="hint">One row per code. Codes missing from this table are flagged for the manager. Missing codes (e.g. 98, 99) are left blank unless you add them here.</p>
        <div id="dv_labels">${(d.labels?.length ? d.labels : [{}]).map(labelRow).join('')}</div>
        <div class="row"><button class="small ghost" data-act="addLabel">+ Add code</button><button class="small ghost" data-act="fillLabels">Fill in the question's codes</button></div></div>
      <div id="dv_combine" ${k === 'combine' ? '' : 'hidden'}>
        <p class="hint">Choose columns in order. You can use questions and added columns listed above this one. If any of them is blank for a respondent, the result is blank.</p>
        <div id="dv_parts">${(d.parts?.length ? d.parts : ['', '']).map(partRow).join('')}</div><button class="small ghost" data-act="addPart">+ Add column</button>
        <label class="f"><span>Separator</span><input id="dv_sep" value="${esc(d.sep ?? '|')}" class="tiny" maxlength="3"></label></div>
      </div><div class="actions"><button class="ghost" data-act="closeModal">${can ? 'Cancel' : 'Close'}</button>${can ? `<button class="primary" data-act="saveDerived" data-di="${i}">Done</button>` : ''}</div>`, true);
  }
  function fillLabels() {
    const f = draft().fields.find(x => x.name === val('dv_src'));
    if (!f) return toast('Choose the question first.', 'error');
    if (!f.allowed.length) return toast('That question has no allowed codes in the rules. Type the codes instead.', 'error');
    const have = new Set([...document.querySelectorAll('#dv_labels .lb-from')].map(x => x.value.trim()));
    [...document.querySelectorAll('#dv_labels .label')].forEach(r => { if (!r.querySelector('.lb-from').value.trim() && !r.querySelector('.lb-to').value.trim()) r.remove(); });
    $('#dv_labels').insertAdjacentHTML('beforeend', f.allowed.map(String).filter(c => !have.has(c)).map(c => labelRow({ from: c, to: '' })).join(''));
  }
  function saveDerived(i) {
    try {
      const dr = draft(), kind = val('dv_kind'), name = val('dv_name').trim();
      const num = s => s.trim() === '' ? null : Number(s.trim());
      let def;
      if (kind === 'band') {
        const bands = [...document.querySelectorAll('#dv_bands .band')].map(r => ({ min: num(r.querySelector('.bd-min').value), max: num(r.querySelector('.bd-max').value), label: r.querySelector('.bd-label').value.trim() }))
          .filter(b => b.min !== null || b.max !== null || b.label);
        if (bands.some(b => b.min === null || Number.isNaN(b.min) || Number.isNaN(b.max))) throw Error('Each band needs a “from” number, and “to” must be a number or empty.');
        def = { name, kind, source: val('dv_src'), bands: bands.sort((a, b) => a.min - b.min) };
      } else if (kind === 'label') {
        const labels = [...document.querySelectorAll('#dv_labels .label')].map(r => ({ from: r.querySelector('.lb-from').value.trim(), to: r.querySelector('.lb-to').value.trim() })).filter(m => m.from || m.to);
        def = { name, kind, source: val('dv_src'), labels };
      } else def = { name, kind, parts: [...document.querySelectorAll('#dv_parts .pt')].map(x => x.value).filter(Boolean), sep: val('dv_sep') };
      const list = E.clone(dr.derived), old = i >= 0 ? list[i].name : null;
      if (i >= 0) list[i] = def; else list.push(def);
      // Renaming keeps later combined columns pointing at the right column.
      if (old && old !== name) for (const x of list) if (x.kind === 'combine') x.parts = x.parts.map(n => n === old ? name : n);
      const mine = E.validateDerived({ ...P, ...dr, derived: list }).filter(e => e.startsWith('Added column ' + (name || '(no name)') + ':'));
      if (mine.length) throw Error(mine[0]);
      dr.derived = list; closeModal(); ui.draftDirty = true; render();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- step 4 ----------
  function step4(s) {
    const can = canAct(['cleaner']), approved = rulesApproved();
    if (!P.datasets.length) return `<h1>Check, fix & inspect</h1><div class="card empty-state"><p>Add a data file first.</p><button data-act="go" data-step="2">Go to step 2</button></div>`;
    const c = s.c;
    const tabs = [['issues', `Issues (${s.issues.length})`], ['resp', `Respondents (${c.inspected}/${c.original} inspected)`], ['changes', `Change log (${c.changed})`]];
    return `<h1>Check, fix & inspect</h1>
      <p class="lead">Checks run on every respondent using the approved rules. The manager decides each issue, the cleaner applies the decisions, and every respondent is inspected by a person. Nothing is changed without a record, and missing answers are never filled in by guesswork.</p>
      <div class="tiles">
        ${tile('Respondents', c.original)}${tile('Needs manager decision', s.needDecision)}${tile('Decisions to apply', s.toApply)}
        ${tile('Inspected', c.inspected + ' / ' + c.original)}${tile('Cells changed', c.changed)}${tile('Excluded', c.excluded)}
      </div>
      <div class="row toolbar">
        ${approved ? `<button class="${s.checksCurrent ? 'ghost' : 'primary'}" data-act="runChecks" ${can ? '' : 'disabled'}>${s.checksCurrent ? 'Re-run checks' : 'Run checks & approved corrections'}</button>` : '<span class="warn">⚠ The manager must approve the rules (step 3) before checks can be run.</span>'}
        ${s.toApply ? `<button class="primary" data-act="applyDecisions" ${can ? '' : 'disabled'}>Apply ${plural(s.toApply, 'decision')}</button>` : ''}
        <button class="ghost" data-act="downloadLogs">Download logs (Excel)</button>
        <button class="ghost" data-act="downloadDraft">Download working data (DRAFT)</button>
      </div>
      ${can ? '' : roleHint(['cleaner'], 'run checks, apply decisions or mark inspections')}
      <div class="tabs">${tabs.map(([k, l]) => `<button class="${ui.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${esc(l)}</button>`).join('')}</div>
      ${ui.tab === 'issues' ? issuesTab(s) : ui.tab === 'resp' ? respTab() : changesTab()}`;
  }
  function issueStatus(i) {
    if (!i.decision) return 'open';
    if (i.decision.action === 'retain') return 'retained';
    return i.decision.applied ? 'applied' : 'decided';
  }
  function filteredIssues(s) {
    const f = ui.issues, q = f.q.trim().toLowerCase();
    return s.issues.filter(i => (f.status === 'all' || issueStatus(i) === f.status) && (!f.code || i.code === f.code) && (!f.field || i.field === f.field) && (!q || String(i.respondent).toLowerCase().includes(q)));
  }
  function issuesTab(s) {
    const f = ui.issues, list = filteredIssues(s), page = Math.min(f.page, Math.max(0, Math.ceil(list.length / PAGE) - 1));
    const counts = { open: 0, decided: 0, retained: 0 }; s.issues.forEach(i => { counts[issueStatus(i)] = (counts[issueStatus(i)] || 0) + 1; });
    const codes = [...new Set(s.issues.map(i => i.code))].sort(), fields = [...new Set(s.issues.map(i => i.field).filter(Boolean))].sort();
    const isMgr = canAct(['manager']);
    const rows = list.slice(page * PAGE, page * PAGE + PAGE).map(i => {
      const st = issueStatus(i), d = ds(i.datasetId), r = rowOf(i.datasetId, i.rowKey);
      return `<tr class="click" data-act="openIssue" data-id="${esc(i.id)}">
        ${isMgr ? `<td class="c" data-stop="1"><input type="checkbox" class="isel" data-id="${esc(i.id)}" ${f.sel.has(i.id) ? 'checked' : ''} ${st === 'open' ? '' : 'disabled'}></td>` : ''}
        <td>${esc(i.respondent || '—')}</td><td>${P.datasets.length > 1 ? esc(d?.name) + ' · ' : ''}${r?.sourceRow ?? ''}</td><td>${esc(i.field || '(whole respondent)')}</td>
        <td>${i.field ? showCell(i.observed) : ''}</td><td>${esc(PROBLEMS[i.code] || i.code)}<small class="sub">${esc(i.message)}</small></td>
        <td>${st === 'open' ? '<span class="tag bad">Needs decision</span>' : `<span class="tag ${st === 'retained' ? 'warn' : 'ok'}">${esc(ACTIONS[i.decision.action])}${st === 'decided' ? ' · to apply' : ''}</span>`}</td></tr>`;
    }).join('');
    return `<div class="card">
      <div class="filters">
        <select id="if_status">${[['open', `Needs decision (${counts.open || 0})`], ['decided', `Decided, not yet applied (${counts.decided || 0})`], ['retained', `Retained & flagged (${counts.retained || 0})`], ['all', 'All issues']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="if_code"><option value="">All problem types</option>${codes.map(c => `<option value="${c}" ${f.code === c ? 'selected' : ''}>${esc(PROBLEMS[c] || c)}</option>`).join('')}</select>
        <select id="if_field"><option value="">All questions</option>${fields.map(c => `<option ${f.field === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <input id="if_q" placeholder="Search respondent ID" value="${esc(f.q)}">
      </div>
      ${isMgr && f.status === 'open' && list.length ? `<div class="bulk"><label class="check"><input type="checkbox" id="isel_all" ${list.length && list.slice(page * PAGE, page * PAGE + PAGE).every(i => f.sel.has(i.id)) ? 'checked' : ''}> Select this page</label>
        <span>${f.sel.size} selected</span><button class="small" data-act="bulkDecide" data-action="retain" ${f.sel.size ? '' : 'disabled'}>Retain & flag selected…</button>
        <button class="small" data-act="bulkDecide" data-action="exclude" ${f.sel.size ? '' : 'disabled'}>Exclude selected respondents…</button></div>` : ''}
      ${list.length ? `<div class="tablewrap"><table><thead><tr>${isMgr ? '<th></th>' : ''}<th>Respondent</th><th>Resp #</th><th>Question</th><th>Value</th><th>Problem</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>${pager(list.length, page, 'issuePage')}`
        : `<p class="muted center">${s.issues.length ? 'No issues match these filters.' : P.datasets.every(d => d.lastRunApproval) ? '🎉 No issues found.' : 'Run the checks to find issues.'}</p>`}
      <p class="hint">Click an issue to see the respondent and record the manager's decision. Each issue must end as: correct from verified evidence, retain and flag, or exclude with a reason.</p></div>`;
  }
  function issueModal(id) {
    const i = E.allIssues(P).find(x => x.id === id); if (!i) return toast('This issue is no longer active (the data changed).', 'error');
    const d = ds(i.datasetId), r = rowOf(i.datasetId, i.rowKey), dec = i.decision, isMgr = canAct(['manager']);
    const answers = d.outputColumns.map(col => `<tr class="${col === i.field ? 'hl' : ''}"><td>${esc(col)}</td><td>${showCell(r.current[col])}</td></tr>`).join('');
    const form = isMgr && !(dec && dec.applied) ? `<h3>Manager decision</h3>
      <div class="choices">${Object.entries(ACTIONS).map(([k, l]) => `<label class="choice"><input type="radio" name="dec" value="${k}" ${(dec?.action || '') === k ? 'checked' : ''}><b>${l}</b><small>${{ retain: 'Keep the answer as it is; it stays flagged in the logs.', correct: 'Change an answer, only with verified evidence (callback, vendor confirmation).', exclude: 'Remove this respondent from the final dataset. The original row is kept.' }[k]}</small></label>`).join('')}</div>
      <div id="dec_correct" class="${dec?.action === 'correct' ? '' : 'hidden'}"><div class="grid2">
        ${i.field ? `<div class="f"><span>Answer to correct</span><b>${esc(i.field)}</b></div>` : `<label class="f"><span>Answer to correct</span><select id="dec_field">${d.outputColumns.map(c => `<option ${dec?.field === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>`}
        <label class="f"><span>Corrected value</span><input id="dec_value" value="${esc(dec?.value ?? '')}"></label></div>
        <label class="f"><span>Verified evidence</span><input id="dec_evidence" value="${esc(dec?.evidence ?? '')}" placeholder="e.g. Callback on 14 Nov, respondent confirmed age 34"></label></div>
      <label class="f"><span>Reason</span><input id="dec_reason" value="${esc(dec?.reason ?? '')}" placeholder="Why this decision"></label>
      <label class="f"><span>Decision reference (optional)</span><input id="dec_ref" value="${esc(dec?.reference ?? '')}" placeholder="e.g. email 14 Nov, meeting note"></label>` : '';
    openModal(`<h2 id="modal-title">${esc(PROBLEMS[i.code] || i.code)}</h2><div class="modal-body">
      <div class="issuehead"><div><small>Respondent</small><b>${esc(i.respondent || '—')}</b></div><div><small>File / Resp #</small><b>${esc(d.name)} · ${r.sourceRow}</b></div>
        <div><small>Question</small><b>${esc(i.field || 'Whole respondent')}</b></div>${i.field ? `<div><small>Value</small><b>${showCell(i.observed)}</b></div>` : ''}</div>
      <p>${esc(i.message)}</p>
      ${dec ? `<div class="decided"><b>${esc(ACTIONS[dec.action])}</b>${dec.field && dec.action === 'correct' ? ` · ${esc(dec.field)} → “${esc(dec.value)}”` : ''} — by ${esc(dec.by)}, ${fmtDate(dec.at)}<br><small>Reason: ${esc(dec.reason)}${dec.evidence ? ' · Evidence: ' + esc(dec.evidence) : ''}${dec.reference ? ' · Ref: ' + esc(dec.reference) : ''}</small>${dec.applied ? '<br><span class="tag ok">Applied to the data</span>' : dec.action !== 'retain' ? '<br><span class="tag warn">Waiting for the cleaner to apply</span>' : ''}</div>` : ''}
      ${isMgr ? '' : roleHint(['manager'], 'record issue decisions')}
      ${form}
      <details><summary>All answers for this respondent</summary><div class="tablewrap short"><table>${answers}</table></div></details>
      </div><div class="actions"><button class="ghost" data-act="closeModal">Close</button>${form ? `<button class="primary" data-act="saveDecision" data-id="${esc(i.id)}">Save decision</button>` : ''}</div>`, true);
  }
  function saveDecision(id) {
    const action = document.querySelector('input[name="dec"]:checked')?.value;
    if (!action) return toast('Choose a decision.', 'error');
    const decision = { action, reason: val('dec_reason').trim(), reference: val('dec_ref').trim() };
    if (action === 'correct') Object.assign(decision, { value: val('dec_value'), evidence: val('dec_evidence').trim(), field: val('dec_field') });
    return run(() => { E.decide(P, id, decision, actor()); closeModal(); toast('Decision recorded.'); });
  }
  function bulkDecide(action) {
    const n = ui.issues.sel.size;
    const respondents = new Set(E.allIssues(P).filter(i => ui.issues.sel.has(i.id)).map(i => i.rowKey)).size;
    confirmBox(action === 'retain' ? `Retain & flag ${plural(n, 'issue')}` : `Exclude ${plural(respondents, 'respondent')}`,
      `<p>${action === 'retain' ? 'The answers stay as they are and remain flagged in the logs.' : 'These respondents will be excluded from the final dataset once the cleaner applies the decision. Original rows are kept.'} Each issue gets its own decision record with this reason.</p>
      <label class="f"><span>Reason (required)</span><input id="bulk_reason" autofocus></label><label class="f"><span>Decision reference (optional)</span><input id="bulk_ref"></label>`,
      action === 'retain' ? 'Retain & flag' : 'Exclude', () => {
        const reason = val('bulk_reason').trim(), reference = val('bulk_ref').trim();
        if (!reason) { toast('Enter a reason.', 'error'); return false; }
        return run(() => {
          let done = 0;
          for (const id of ui.issues.sel) { if (E.allIssues(P).some(i => i.id === id && !i.decision)) { E.decide(P, id, { action, reason, reference }, actor()); done++; } }
          ui.issues.sel.clear(); closeModal(); toast(`${plural(done, 'decision')} recorded.`);
        });
      }, action === 'exclude');
  }
  function respList() {
    const f = ui.resp, q = f.q.trim().toLowerCase();
    const issueRows = new Set(E.allIssues(P).filter(i => issueStatus(i) !== 'retained').map(i => i.rowKey));
    const out = [];
    for (const d of P.datasets) for (const r of d.rows) {
      const ok = f.filter === 'all' || (f.filter === 'todo' && !r.inspected) || (f.filter === 'issues' && issueRows.has(r.key)) || (f.filter === 'excluded' && r.excluded) || (f.filter === 'done' && r.inspected);
      if (ok && (!q || String(r.respondent || '').toLowerCase().includes(q))) out.push({ d, r, issues: issueRows.has(r.key) });
    }
    return out;
  }
  function respTab() {
    const f = ui.resp, list = respList(), page = Math.min(f.page, Math.max(0, Math.ceil(list.length / PAGE) - 1)), can = canAct(['cleaner']);
    const shown = list.slice(page * PAGE, page * PAGE + PAGE);
    const rows = shown.map(({ d, r, issues }) => `<tr class="click" data-act="openResp" data-d="${d.id}" data-k="${esc(r.key)}">
      <td>${esc(r.respondent || '—')}</td><td>${P.datasets.length > 1 ? esc(d.name) + ' · ' : ''}${r.sourceRow}</td>
      <td>${r.excluded ? '<span class="tag bad">Excluded</span>' : '<span class="tag ok">Included</span>'}</td>
      <td>${issues ? '<span class="tag warn">Open issues</span>' : ''}</td><td>${r.inspected ? '✓ ' + esc(r.inspected.by) : '<span class="muted">Not yet</span>'}</td></tr>`).join('');
    const pending = list.filter(x => !x.r.inspected).length;
    return `<div class="card"><div class="filters">
      <select id="rf_filter">${[['todo', 'Not inspected yet'], ['issues', 'With open issues'], ['excluded', 'Excluded'], ['done', 'Inspected'], ['all', 'All respondents']].map(([v, l]) => `<option value="${v}" ${f.filter === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input id="rf_q" placeholder="Search respondent ID" value="${esc(f.q)}">
      ${can && pending ? `<button class="small" data-act="inspectShown" data-n="${shown.filter(x => !x.r.inspected).length}">Mark the ${shown.filter(x => !x.r.inspected).length} on this page as inspected…</button>` : ''}</div>
      ${list.length ? `<div class="tablewrap"><table><thead><tr><th>Respondent</th><th>Resp #</th><th>Status</th><th>Issues</th><th>Inspected by</th></tr></thead><tbody>${rows}</tbody></table></div>${pager(list.length, page, 'respPage')}` : '<p class="muted center">No respondents in this view.</p>'}
      <p class="hint">SOP 3.1: a person must look at each respondent, including open-ended answers and unusual combinations. Running the checks does not count as inspection. If data changes after inspection, the respondent must be inspected again.</p></div>`;
  }
  function respModal(dId, key) {
    const d = ds(dId), r = rowOf(dId, key), can = canAct(['cleaner']), canFlag = canAct(['cleaner', 'manager']);
    const iss = E.allIssues(P).filter(i => i.rowKey === key);
    const byField = new Map(); iss.forEach(i => { const k = i.field || ''; if (!byField.has(k)) byField.set(k, []); byField.get(k).push(i); });
    const rev = new Map(Object.entries(d.mapping || {}).map(([field, src]) => [field, src]));
    const rows = d.outputColumns.map((col, j) => {
      const orig = r.original[d.sourceColumns[j]] || r.original[rev.get(col)], cur = r.current[col], changed = E.stable(orig) !== E.stable(cur);
      const fi = byField.get(col) || [];
      return `<tr class="${fi.length ? 'hl' : ''}"><td><b>${esc(col)}</b>${P.fields.find(f => f.name === col)?.label ? `<small class="sub">${esc(P.fields.find(f => f.name === col).label)}</small>` : ''}</td>
        <td>${showCell(cur)}${changed ? `<small class="sub">was: ${showCell(orig)}</small>` : ''}</td>
        <td>${fi.map(i => `<button class="link" data-act="openIssue" data-id="${esc(i.id)}">${esc(PROBLEMS[i.code] || i.code)}${i.decision ? ' · ' + esc(ACTIONS[i.decision.action]) : ''}</button>`).join('<br>')}</td>
        <td>${canFlag && !r.excluded ? `<button class="small ghost" data-act="flagCell" data-d="${dId}" data-k="${esc(key)}" data-f="${esc(col)}">Flag</button>` : ''}</td></tr>`;
    }).join('');
    const dv = E.derive(P, r.current).values;
    const addedRows = (P.derived || []).map(x => `<tr><td><b>${esc(x.name)}</b><small class="sub">Added column</small></td><td>${showCell(dv[x.name])}</td><td></td><td></td></tr>`).join('');
    const whole = (byField.get('') || []).map(i => `<button class="link" data-act="openIssue" data-id="${esc(i.id)}">${esc(PROBLEMS[i.code] || i.code)}: ${esc(i.message)}</button>`).join('<br>');
    openModal(`<h2 id="modal-title">Respondent ${esc(r.respondent || '(no ID)')}</h2><div class="modal-body">
      <p class="muted">${esc(d.name)} · Resp # ${r.sourceRow} (row in the raw file) · ${r.excluded ? `<span class="tag bad">Excluded</span> ${esc(r.excluded.reason)}` : '<span class="tag ok">Included</span>'} · ${r.inspected ? `Inspected by ${esc(r.inspected.by)}, ${fmtDate(r.inspected.at)}` : 'Not inspected yet'}</p>
      ${whole ? `<div class="decided">${whole}</div>` : ''}
      <div class="tablewrap tall"><table><thead><tr><th>Question</th><th>Answer</th><th>Issues</th><th></th></tr></thead><tbody>${rows}${addedRows}</tbody></table></div>
      <p class="hint">Use <b>Flag</b> if you see a problem the checks did not catch, e.g. a meaningless open-ended answer. The manager then decides what to do.</p></div>
      <div class="actions"><button class="ghost" data-act="closeModal">Close</button>${can && !r.inspected ? `<button class="primary" data-act="inspectOne" data-d="${dId}" data-k="${esc(key)}">I have inspected this respondent</button>` : ''}</div>`, true);
  }
  function changesTab() {
    const all = P.datasets.flatMap(d => d.changes.map(c => ({ d, c }))).reverse();
    const page = Math.min(ui.changesPage, Math.max(0, Math.ceil(all.length / PAGE) - 1));
    return `<div class="card">${all.length ? `<div class="tablewrap"><table><thead><tr><th>Respondent</th><th>Question</th><th>Before</th><th>After</th><th>Reason</th><th>By / when</th></tr></thead><tbody>
      ${all.slice(page * PAGE, page * PAGE + PAGE).map(({ c }) => `<tr><td>${esc(c.respondent || c.rowKey.split(':').pop())}</td><td>${esc(c.field)}</td><td>${showCell(c.before)}</td><td>${showCell(c.after)}</td><td>${esc(c.reason)}</td><td>${esc(c.operator)}<small class="sub">${fmtDate(c.at)}</small></td></tr>`).join('')}
      </tbody></table></div>${pager(all.length, page, 'changesPage')}` : '<p class="muted center">No changes yet. Every change is recorded here with its before and after values, reason and approval.</p>'}
      ${E.count(P).excluded ? `<h3>Exclusions</h3><div class="tablewrap short"><table><thead><tr><th>Respondent</th><th>Resp #</th><th>Reason</th><th>Decided by</th></tr></thead><tbody>${P.datasets.flatMap(d => d.rows.filter(r => r.excluded).map(r => `<tr><td>${esc(r.respondent)}</td><td>${r.sourceRow}</td><td>${esc(r.excluded.reason)}</td><td>${esc(r.excluded.by)}</td></tr>`)).join('')}</tbody></table></div>` : ''}</div>`;
  }
  async function runChecks() {
    let changes;
    try { changes = await E.preview(P); } catch (e) { return toast(e.message, 'error'); }
    const list = changes.slice(0, 30).map(x => `<tr><td>${esc(x.file)} · ${x.row}</td><td>${esc(x.field)}</td><td>${showCell(x.before)}</td><td>${showCell(x.after)}</td></tr>`).join('');
    confirmBox('Run checks on all respondents', `<p>Every respondent will be checked against the approved rules.</p>
      ${changes.length ? `<p><b>${plural(changes.length, 'cell')}</b> will be changed by the approved automatic corrections (recodes, trimming, conversions). Each change is logged with its before and after values.</p>
      <div class="tablewrap short"><table><thead><tr><th>Resp #</th><th>Question</th><th>Before</th><th>After</th></tr></thead><tbody>${list}</tbody></table></div>${changes.length > 30 ? `<p class="hint">…and ${changes.length - 30} more.</p>` : ''}` : '<p>No automatic corrections apply. The data will only be checked.</p>'}`,
      changes.length ? 'Run checks & apply corrections' : 'Run checks', async () => {
        closeModal(); ui.cancel = false;
        await run(async () => {
          $('#busy button').hidden = false;
          const n = await E.clean(P, actor(), progress, () => ui.cancel);
          const s = status(); ui.tab = 'issues'; ui.issues.status = 'open'; ui.issues.page = 0;
          toast(`Checks complete. ${plural(n, 'cell')} corrected by approved rules; ${plural(s.issues.length, 'issue')} found.`);
        }, { msg: 'Checking every respondent…' });
      });
  }

  // ---------- step 5 ----------
  const REVIEW_CHECKS = [
    'QRE version and approved rules match the dataset (SOP 5.2)',
    'Receipt log and sample reconciliation are correct (SOP 5.2)',
    'Every change and decision has an approved reason and evidence (SOP 5.2–5.3)',
    'Respondent IDs, skip routes and exclusions checked against the original data (SOP 5.3)',
    'Final count matches: original = excluded + final included (SOP 5.3)'
  ];
  function summaryCards(s) {
    const c = s.c, retained = s.issues.filter(i => i.decision?.action === 'retain').length;
    return `<div class="tiles">${tile('Original', c.original)}${tile('Excluded', c.excluded)}${tile('Final included', c.included)}${tile('Cells changed', c.changed)}${tile('Retained flags', retained)}${tile('Inspected', c.inspected + ' / ' + c.original)}</div>
      <p class="recon ${c.original === c.excluded + c.included ? 'ok' : 'bad'}">Reconciliation: ${c.original} original = ${c.excluded} excluded + ${c.included} included ${c.original === c.excluded + c.included ? '✓' : '✗'}</p>
      <div class="kv"><span>QRE</span><b>${esc(P.qreVersion)} · ${esc(P.qre?.name || '')}</b><span>Rules approved by</span><b>${esc(P.ruleApproval?.by || '—')} · ${fmtDate(P.ruleApproval?.at)}</b>
        <span>Cleaned by</span><b>${esc(P.cleaners.join(', ') || '—')}</b><span>Margin of error</span><b>${esc(P.moe)} — ${esc(P.moeBasis)}</b></div>`;
  }
  function gatesBox(s) {
    if (!s.gates.length) return '';
    return `<div class="card warncard"><h2>Not ready yet</h2><ul>${s.gates.map(g => `<li>${esc(g)}</li>`).join('')}</ul><button class="small" data-act="go" data-step="4">Go to step 4</button></div>`;
  }
  function step5(s) {
    const isRev = canAct(['reviewer']), self = P.cleaners.some(n => E.normalName(n) === E.normalName(P.roles.reviewer));
    const attempts = P.history.filter(h => h.event.startsWith('Independent verification'));
    return `<h1>Independent review</h1>
      <p class="lead">Someone who did <b>not</b> clean this data checks it against the original data and the questionnaire. The reviewer records pass or fail but never edits the data. If it fails, it goes back to the cleaner.</p>
      ${self ? `<div class="card warncard"><b>${esc(P.roles.reviewer)}</b> cleaned this dataset and cannot review it. The manager must appoint a different reviewer in step 1.</div>` : ''}
      ${gatesBox(s)}
      ${P.datasets.map(d => healthCard(d, true)).join('')}
      <div class="card"><h2>What to review</h2>${summaryCards(s)}
        <div class="row"><button class="ghost small" data-act="downloadLogs">Download logs (Excel)</button><button class="ghost small" data-act="downloadDraft">Download cleaned data (DRAFT)</button><button class="ghost small" data-act="downloadOriginals">Download original file(s)</button>
          <button class="ghost small" data-act="go" data-step="4">Browse issues & respondents (read-only)</button></div></div>
      ${P.verification ? `<div class="card okcard"><h2>✓ Verification passed</h2><p>By <b>${esc(P.verification.by)}</b> on ${fmtDate(P.verification.at)}.<br><small>${esc(P.verification.note)}</small></p><p class="hint">Any later change to the data, rules or decisions cancels this and the review must be repeated.</p></div>` : `
      <div class="card"><h2>Reviewer sign-off</h2>${roleHint(['reviewer'], 'record the review')}
        ${isRev ? `${REVIEW_CHECKS.map((t, i) => `<label class="check"><input type="checkbox" id="rv_${i}"> ${esc(t)}</label>`).join('')}
        <label class="f"><span>Findings / notes (required)</span><textarea id="rv_note" rows="3" placeholder="What you checked and any errors found"></textarea></label>
        <div class="actions"><button class="danger" data-act="verify" data-pass="0">Fail: return to cleaner</button><button class="primary" data-act="verify" data-pass="1" ${s.gates.length || self ? 'disabled' : ''}>Pass verification</button></div>` : ''}</div>`}
      ${attempts.length ? `<div class="card"><h2>Review history</h2><ul class="hist">${attempts.map(h => `<li><b>${h.passed ? 'Passed' : 'Failed'}</b> by ${esc(h.actor)} · ${fmtDate(h.at)}<small>${esc(h.note)}</small></li>`).join('')}</ul></div>` : ''}`;
  }

  // ---------- step 6 ----------
  function nextVersion() {
    const used = P.history.filter(h => h.event === 'Release exported').map(h => +String(h.version).replace(/\D/g, '') || 0);
    return 'v' + String((used.length ? Math.max(...used) : 0) + 1).padStart(3, '0');
  }
  function step6(s) {
    const isMgr = canAct(['manager']);
    const retained = s.issues.filter(i => i.decision?.action === 'retain');
    return `<h1>Manager approval</h1>
      <p class="lead">The manager checks the escalations, decisions and review result, then approves this exact version for release. Approving locks in this version; any later change cancels the approval.</p>
      ${!P.verification ? `<div class="card warncard">Waiting for a passed independent review (step 5).</div>` : `<div class="card okcard">✓ Independent review passed by <b>${esc(P.verification.by)}</b>, ${fmtDate(P.verification.at)}</div>`}
      <div class="card"><h2>Release summary</h2>${summaryCards(s)}
        ${retained.length ? `<p class="hint">${plural(retained.length, 'issue')} will stay in the dataset as retained flags (each decided by the manager). They are listed in the logs.</p>` : ''}
        <div class="row"><button class="ghost small" data-act="downloadLogs">Download logs (Excel)</button></div></div>
      ${P.approval ? `<div class="card okcard"><h2>✓ Approved for release as ${esc(P.approval.version)}</h2><p>By <b>${esc(P.approval.by)}</b>, ${fmtDate(P.approval.at)}.<br><small>${esc(P.approval.note)}</small></p></div>` : `
      <div class="card"><h2>Decision</h2>${roleHint(['manager'], 'approve the release')}
        ${isMgr ? `<div class="grid2"><label class="f"><span>Release version</span><input id="ap_version" value="${nextVersion()}"></label>
          <label class="f"><span>Note (required)</span><input id="ap_note" placeholder="e.g. Escalations reviewed; approved for reporting"></label></div>
          <div class="actions"><button class="danger" data-act="approve" data-ok="0">Reject: return to cleaning</button><button class="primary" data-act="approve" data-ok="1" ${P.verification ? '' : 'disabled'}>Approve release</button></div>` : ''}</div>`}`;
  }

  // ---------- step 7 ----------
  function step7() {
    const isRel = canAct(['releaser']);
    return `<h1>Release</h1>
      <p class="lead">Create the approved files and save them to the correct project folder. Keep ORIGINAL, WORKING and APPROVED files separate (SOP 7.2), and do not share superseded or unapproved files as final.</p>
      ${!P.approval ? '<div class="card warncard">Waiting for manager approval (step 6).</div>' : ''}
      ${P.released ? `<div class="card okcard"><h2>✓ Released ${esc(P.released.version)}</h2><p>By <b>${esc(P.released.by)}</b>, ${fmtDate(P.released.at)}${P.released.destination ? ' · saved to ' + esc(P.released.destination) : ''}.</p>
        <div class="row"><button data-act="downloadApproved">Download approved Excel again</button><button class="ghost" data-act="downloadRelease">Download release package again</button></div></div>
        <div class="card"><h2>Message for the team</h2><p class="hint">Copy this into the DATA team group, or attach the release note.</p><pre class="note-text" id="relnote">${esc(teamMessage())}</pre><button class="small ghost" data-act="copyNote">Copy message</button></div>` : P.approval ? `
      <div class="card"><h2>Create the release</h2>${roleHint(['releaser'], 'create the release')}
        ${isRel ? `<label class="f"><span>Where you will save it (written into the release note)</span><input id="rl_dest" placeholder="e.g. D:\\Projects\\${esc(IO.nameSafe(P.name))}\\APPROVED"></label>
        <p class="hint">You will get: <b>the approved Excel file</b> and <b>a release package (.zip)</b> holding the ORIGINAL, WORKING, LOGS and APPROVED folders, the manifest and the release note. Choose a local, non-synced folder if the data must stay on this computer.</p>
        <div class="actions"><button class="primary" data-act="release">Create release</button></div>` : ''}</div>` : ''}`;
  }
  function teamMessage() {
    return `Project: ${P.name}\nSurvey mode: ${P.mode}\nFinal valid sample: ${E.count(P).included}\nApproved version: ${P.released?.version || P.approval?.version}\nLocation: ${P.released?.destination || '(not recorded)'}\nReady for BDR / A&R / VS`;
  }

  // ---------- project actions ----------
  async function saveProject() {
    await run(async () => {
      const bytes = await IO.packageProject(P, false);
      const d = new Date(), t = IO.stamp(d) + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
      download(bytes, `${IO.nameSafe(P.name)}_${t}_${E.stage(P).replace(/\s+/g, '-')}.zip`, 'application/zip');
      ui.dirty = false; toast('Project saved to your Downloads. Open this .zip to continue later or to pass the work on.');
    }, { mutate: false, msg: 'Saving project…' });
  }
  async function openProject(file) {
    if (P && ui.dirty) return confirmBox('Discard unsaved changes?', '<p>The current project has unsaved changes.</p>', 'Open anyway', () => { ui.dirty = false; closeModal(); openProject(file); }, true);
    await run(async () => {
      const p = await IO.openPackage(file);
      P = p; ui.dirty = E.ensureAccounts(P) > 0; ui.draft = null; ui.pending = null; ui.queue = []; ui.issues.sel.clear(); ui.setup = false;
      user = null; role = null; ui.loginAs = null; healthCache.clear();
      await refreshDigest();
      ui.step = nextAction(status()).step;
      toast('Opened ' + P.name + '. Integrity checks passed. Please sign in.');
    }, { mutate: false, msg: 'Opening and checking project…' });
  }
  function newProject() { P = null; user = null; role = null; ui.dirty = false; ui.guide = false; ui.setup = true; ui.setupVals = null; render(); }

  async function release() {
    const dest = val('rl_dest').trim();
    await run(async () => {
      const digest = await E.releaseCheck(P, actor()), mark = P.history.length;
      let books, zip;
      E.markReleased(P, actor(), dest, digest);
      try {
        books = P.datasets.map(d => [IO.datasetWorkbook(P, d), IO.datasetFileName(P, d, true)]);
        zip = await IO.packageProject(P, true, dest);
      } catch (e) { P.released = null; P.history.length = mark; throw e; }
      for (const [bytes, name] of books) download(bytes, name, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      download(zip, `${IO.nameSafe(P.name)}_${P.approval.version}_RELEASE_PACKAGE.zip`, 'application/zip');
      ui.dirty = false;
      toast('Released. The approved Excel and release package are in your Downloads. Move them to the project folder. The release package is also your saved project.');
    }, { msg: 'Building release…' });
  }

  // ---------- events ----------
  const acts = {
    newProject: () => (P && ui.dirty) ? confirmBox('Discard unsaved changes?', '<p>The current project has unsaved changes.</p>', 'Start new', () => { closeModal(); ui.dirty = false; newProject(); }, true) : newProject(),
    guide: () => {
      if (P) { openModal(`<div class="modal-body guide">${guideHtml()}</div><div class="actions"><button class="ghost" data-act="closeModal">Close guide</button></div>`, true); $('#modal').classList.add('guidebox'); return; }
      ui.guide = true; render(); window.scrollTo(0, 0);
    },
    closeGuide: () => { ui.guide = false; render(); window.scrollTo(0, 0); },
    openProject: () => pickFile('#project-input'),
    saveProject, closeProject: () => {
      const go = () => { P = null; user = null; role = null; ui.dirty = false; ui.pending = null; ui.draft = null; ui.setup = false; ui.guide = false; closeModal(); render(); };
      ui.dirty ? confirmBox('Close without saving?', '<p>Unsaved changes will be lost. Click <b>Save project</b> first to keep them.</p>', 'Close without saving', go, true) : go();
    },
    go: el => { ui.step = +el.dataset.step; window.scrollTo(0, 0); render(); },
    becomeRole: el => { if (myRoles().includes(el.dataset.role)) role = el.dataset.role; render(); },
    cancelSetup: () => { ui.setup = false; ui.setupVals = null; render(); }, createProject,
    pickLogin: el => { ui.loginAs = el.dataset.name; render(); }, signIn, signOut,
    saveRoles: () => {
      const roles = Object.fromEntries(Object.keys(ROLES).map(r => [r, val('ro_' + r)]));
      if (Object.keys(roles).every(r => E.normalName(roles[r]) === E.normalName(P.roles[r]))) return toast('No role changes to save.');
      run(() => { E.setRoles(P, actor(), roles, val('ro_reason') || ''); const mine = myRoles(); if (!mine.includes(role)) role = mine[0] || null; toast('Roles updated.'); });
    },
    addPerson: () => run(() => { E.addPerson(P, actor(), val('newPerson')); toast('Added. They create their password when they first sign in.'); }),
    resetPw: el => confirmBox('Reset password?', `<p><b>${esc(el.dataset.name)}</b> will create a new password the next time they sign in.</p>`, 'Reset password', () => run(() => { E.resetPassword(P, actor(), el.dataset.name); closeModal(); toast('Password reset.'); }), true),
    closeModal, confirmOk: () => { const f = ui.onConfirm; if (f) f(); },
    saveStep1, attachQre: () => pickFile('#qre-input'),
    chooseData: () => pickFile('#data-input'), cancelPending: () => nextQueued(), registerPending,
    removeDataset: el => confirmBox('Remove dataset?', '<p>Remove this file from the project? You can add it again later. It is only removable because nothing has been changed or decided yet.</p>', 'Remove', () => run(() => { E.removeDataset(P, el.dataset.id, actor()); closeModal(); }), true),
    editField: el => editField(+el.dataset.fi), saveField: el => saveField(+el.dataset.fi),
    addCond: el => { const b = document.getElementById(el.dataset.b); const fields = (ui.draft || P).fields; b.querySelector('.b-rows').insertAdjacentHTML('beforeend', condRow({ field: '', op: 'eq', value: '' }, fields)); },
    delCond: el => el.closest('.b-row').remove(),
    addRecode: () => $('#fm_recodes').insertAdjacentHTML('beforeend', recodeRow({ from: '', to: '' })),
    editCheck: el => editCheck(+el.dataset.ci), saveCheck: el => saveCheck(+el.dataset.ci),
    delCheck: el => { draft().checks.splice(+el.dataset.ci, 1); ui.draftDirty = true; render(); },
    editElig, saveElig: () => { try { draft().eligibility = readBuilder('el_b'); closeModal(); ui.draftDirty = true; render(); } catch (e) { toast(e.message, 'error'); } },
    editDerived: el => editDerived(+el.dataset.di), saveDerived: el => saveDerived(+el.dataset.di), fillLabels,
    delDerived: el => { draft().derived.splice(+el.dataset.di, 1); ui.draftDirty = true; render(); },
    addBand: () => $('#dv_bands').insertAdjacentHTML('beforeend', bandRow({})),
    addLabel: () => $('#dv_labels').insertAdjacentHTML('beforeend', labelRow({})),
    addPart: () => $('#dv_parts').insertAdjacentHTML('beforeend', partRow('')),
    clearElig: () => { draft().eligibility = null; closeModal(); ui.draftDirty = true; render(); },
    discardRules: () => { ui.draft = null; ui.draftDirty = false; render(); },
    saveRules: () => run(() => { const dr = draft(); E.updateRules(P, dr, actor()); ui.draft = null; ui.draftDirty = false; toast('Rules saved. The manager now needs to approve them.'); }),
    approveRules: () => run(async () => { await E.approveRules(P, actor(), val('ruleNote') || ''); toast('Rules approved. The cleaner can now run the checks.'); }),
    loadTemplate: () => pickFile('#template-input'),
    saveTemplateJson: () => { const t = { ...E.template(P), ...(ui.draftDirty ? draft() : {}), savedFrom: P.name, savedAt: E.now(), approval: P.ruleApproval ? { by: P.ruleApproval.by, at: P.ruleApproval.at, qreVersion: P.ruleApproval.qreVersion } : null }; download(IO.encode(JSON.stringify(t, null, 2)), IO.nameSafe(P.name) + '_rules_template.json', 'application/json'); },
    templateXlsx: () => download(IO.templateWorkbook(P), IO.nameSafe(P.name) + '_rules.xlsx'),
    tab: el => { ui.tab = el.dataset.tab; render(); },
    issuePage: el => { ui.issues.page = +el.dataset.page; render(); }, respPage: el => { ui.resp.page = +el.dataset.page; render(); }, changesPage: el => { ui.changesPage = +el.dataset.page; render(); },
    openIssue: el => issueModal(el.dataset.id), saveDecision: el => saveDecision(el.dataset.id),
    bulkDecide: el => bulkDecide(el.dataset.action),
    openResp: el => respModal(el.dataset.d, el.dataset.k),
    flagCell: el => run(() => { const id = E.proposeCellIssue(P, el.dataset.d, el.dataset.k, el.dataset.f, actor()); setTimeout(() => issueModal(id)); }),
    inspectOne: el => run(() => { E.inspect(P, el.dataset.d, el.dataset.k, actor()); closeModal(); toast('Marked as inspected.'); }),
    inspectShown: el => {
      const list = respList(), page = Math.min(ui.resp.page, Math.max(0, Math.ceil(list.length / PAGE) - 1));
      const shown = list.slice(page * PAGE, page * PAGE + PAGE).filter(x => !x.r.inspected);
      confirmBox(`Mark ${plural(shown.length, 'respondent')} as inspected`, `<label class="check"><input type="checkbox" id="attest"> I, <b>${esc(P.roles.cleaner)}</b>, have looked at each of these ${shown.length} respondents, including open-ended answers and unusual combinations.</label>`, 'Mark inspected', () => {
        if (!val('attest')) { toast('Tick the box to confirm you inspected them.', 'error'); return; }
        run(() => { const n = E.inspectMany(P, shown.map(x => ({ datasetId: x.d.id, rowKey: x.r.key })), actor()); closeModal(); toast(plural(n, 'respondent') + ' marked as inspected.'); });
      });
      void el;
    },
    runChecks, applyDecisions: () => run(() => { const n = E.applyDecisions(P, actor()); toast(`${plural(n, 'decision')} applied and checks re-run. Changed respondents need inspecting again.`); }),
    downloadLogs: () => run(() => download(IO.logsWorkbook(P), IO.nameSafe(P.name) + '_LOGS_' + IO.stamp() + '_DRAFT.xlsx'), { mutate: false, msg: 'Building logs…' }),
    downloadDraft: () => run(() => { for (const d of P.datasets) download(IO.datasetWorkbook(P, d), IO.datasetFileName(P, d, false)); }, { mutate: false, msg: 'Building workbook…' }),
    downloadOriginals: () => { for (const d of P.datasets) download(IO.unbase64(d.source64), 'ORIGINAL_' + d.name); },
    verify: el => {
      const pass = el.dataset.pass === '1', checklist = REVIEW_CHECKS.map((_, i) => val('rv_' + i)), note = val('rv_note') || '';
      if (pass && !checklist.every(Boolean)) return toast('Tick all five review checks to pass.', 'error');
      run(async () => { await E.verify(P, actor(), pass, note, checklist); toast(pass ? 'Verification passed. Next: manager approval.' : 'Verification failed. Returned to the cleaner.'); });
    },
    approve: el => {
      const ok = el.dataset.ok === '1';
      run(async () => { await E.approveRelease(P, actor(), ok, val('ap_note') || '', (val('ap_version') || '').trim()); toast(ok ? 'Approved. Next: the releasing analyst creates the release.' : 'Rejected. Returned to cleaning.'); });
    },
    release, downloadApproved: () => run(() => { for (const d of P.datasets) download(IO.datasetWorkbook(P, d), IO.datasetFileName(P, d, true)); }, { mutate: false }),
    downloadRelease: () => run(async () => download(await IO.packageProject(P, true, P.released.destination), `${IO.nameSafe(P.name)}_${P.approval.version}_RELEASE_PACKAGE.zip`, 'application/zip'), { mutate: false, msg: 'Building package…' }),
    copyNote: () => { navigator.clipboard?.writeText(teamMessage()).then(() => toast('Copied.'), () => toast('Select the text and copy it manually.', 'error')); },
    cancelBusy: () => { ui.cancel = true; }
  };

  document.addEventListener('click', e => {
    const stop = e.target.closest('[data-stop]');
    if (stop && !e.target.closest('[data-act]:not(tr)')) return;
    const el = e.target.closest('[data-act]'); if (!el || el.disabled) return;
    const fn = acts[el.dataset.act]; if (fn) { e.preventDefault(); fn(el); }
  });
  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.id === 'drop') { e.preventDefault(); acts.chooseData(); }
    if (e.key === 'Enter' && ['li_pw', 'li_pw2'].includes(e.target.id)) { e.preventDefault(); signIn(); }
    if (e.key === 'Enter' && ['su_pw', 'su_pw2'].includes(e.target.id)) { e.preventDefault(); createProject(); }
  });
  document.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'role') { if (myRoles().includes(t.value)) role = t.value; render(); return; }
    if (t.dataset.fi !== undefined && t.dataset.k) return onRuleInput(t);
    if (t.id === 'fm_always') { $('#fm_routewrap').hidden = t.checked; return; }
    if (t.id === 'dv_resp') { draft().respNumber = t.checked; ui.draftDirty = true; return render(); }
    if (t.id === 'dv_kind') { for (const k of ['band', 'label', 'combine']) $('#dv_' + k).hidden = t.value !== k; $('#dv_srcwrap').hidden = t.value === 'combine'; return; }
    if (t.name === 'dec') { $('#dec_correct').classList.toggle('hidden', t.value !== 'correct'); return; }
    if (t.dataset.map !== undefined) { ui.pending.mapping[t.dataset.map] = t.value; if (!t.value) delete ui.pending.mapping[t.dataset.map]; return render(); }
    if (t.id === 'pd_table') { ui.pending.table = +t.value; ui.pending.header = 1; autoMap(); return render(); }
    if (t.id === 'pd_header') { ui.pending.header = Math.max(1, parseInt(t.value, 10) || 1); autoMap(); return render(); }
    if (t.id === 'pd_delim' || t.id === 'pd_enc') {
      const pd = ui.pending, settings = { delimiter: val('pd_delim'), encoding: val('pd_enc') }, keep = { receivedAt: val('pd_at'), source: val('pd_source'), vendor: val('pd_vendor') };
      return run(async () => { await readPending(pd.file, settings); Object.assign(ui.pending, keep); }, { mutate: false });
    }
    if (t.id === 'if_status') { ui.issues.status = t.value; ui.issues.page = 0; ui.issues.sel.clear(); return render(); }
    if (t.id === 'if_code') { ui.issues.code = t.value; ui.issues.page = 0; return render(); }
    if (t.id === 'if_field') { ui.issues.field = t.value; ui.issues.page = 0; return render(); }
    if (t.classList.contains('isel')) { t.checked ? ui.issues.sel.add(t.dataset.id) : ui.issues.sel.delete(t.dataset.id); return render(); }
    if (t.id === 'isel_all') {
      const list = filteredIssues(status()), page = Math.min(ui.issues.page, Math.max(0, Math.ceil(list.length / PAGE) - 1));
      list.slice(page * PAGE, page * PAGE + PAGE).filter(i => !i.decision).forEach(i => t.checked ? ui.issues.sel.add(i.id) : ui.issues.sel.delete(i.id)); return render();
    }
    if (t.id === 'rf_filter') { ui.resp.filter = t.value; ui.resp.page = 0; return render(); }
    if (t.id === 'data-input') { takeFiles(t.files); return; }
    if (t.id === 'project-input' && t.files[0]) { openProject(t.files[0]); return; }
    if (t.id === 'qre-input' && t.files[0]) {
      const file = t.files[0];
      if (file.size > 50 * 1024 * 1024) return toast('The questionnaire file is larger than 50 MB.', 'error');
      return run(async () => { const b = new Uint8Array(await file.arrayBuffer()); E.attachQre(P, { name: file.name, size: b.length, hash: await E.hash(b), bytes64: IO.base64(b) }, actor()); toast('Questionnaire attached. The manager must approve the rules against it.'); });
    }
    if (t.id === 'template-input' && t.files[0]) {
      const file = t.files[0];
      return run(async () => {
        const tpl = IO.parseTemplate(new Uint8Array(await file.arrayBuffer()), file.name.toLowerCase());
        if (P.datasets.length) { const cols = new Set(P.datasets[0].outputColumns), miss = tpl.fields.filter(f => !cols.has(f.name)).map(f => f.name); if (miss.length) throw Error('These questions in the template are not columns in the data: ' + miss.slice(0, 10).join(', ') + (miss.length > 10 ? '…' : '')); }
        E.updateRules(P, { fields: tpl.fields, checks: tpl.checks || [], eligibility: tpl.eligibility || null, duplicateRows: tpl.duplicateRows !== false, derived: tpl.derived || [], respNumber: tpl.respNumber ?? !!P.respNumber }, actor());
        ui.draft = null; ui.draftDirty = false; ui.step = 3;
        toast(`Loaded ${plural(tpl.fields.length, 'question')} from the template${tpl.qreVersion ? ' (QRE ' + tpl.qreVersion + ')' : ''}. The manager must approve them for this project.`);
      });
    }
  });
  let searchTimer;
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'if_q' || t.id === 'rf_q') {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        if (t.id === 'if_q') { ui.issues.q = t.value; ui.issues.page = 0; } else { ui.resp.q = t.value; ui.resp.page = 0; }
        render(); const el = document.getElementById(t.id); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      }, 250);
    }
  });
  ['dragover', 'drop'].forEach(type => document.addEventListener(type, e => {
    e.preventDefault();
    if (type === 'dragover') { document.body.classList.add('dragging'); return; }
    document.body.classList.remove('dragging');
    const files = [...(e.dataTransfer?.files || [])]; if (!files.length) return;
    if (!P || !user) { if (files[0].name.toLowerCase().endsWith('.zip')) openProject(files[0]); else toast(P ? 'Sign in first, then drop the data file.' : 'Start or open a project first, then drop the data file.', 'error'); return; }
    if (files.length === 1 && files[0].name.toLowerCase().endsWith('.zip')) { openProject(files[0]); return; }
    takeFiles(files);
  }));
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  window.addEventListener('beforeunload', e => { if (P && ui.dirty) { e.preventDefault(); e.returnValue = ''; } });
  $('#modal').addEventListener('close', () => { $('#modal').innerHTML = ''; });
  window.__app = { get P() { return P; }, get user() { return user; }, get role() { return role; }, acts, ui, render };
  render();
})();
