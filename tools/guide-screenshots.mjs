// Regenerates the screenshots used by the in-app guide (src/guide/*.webp).
//   node build.mjs && node tools/guide-screenshots.mjs && node build.mjs
// Needs Google Chrome. Set CHROME=/path/to/chrome if it is not in the usual macOS place.
// Uses a made-up example project; no real data or staff names.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL('../' + p, import.meta.url));
for (const f of ['vendor/xlsx.full.min.js', 'vendor/fflate.min.js', 'src/engine.js', 'src/io.js']) vm.runInThisContext(fs.readFileSync(here(f), 'utf8'), { filename: f });
const E = globalThis.SurveyEngine, IO = globalThis.SurveyIO;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PW = 'example1234';

// ---------- 1. Build the example project in Node ----------
async function exampleProject() {
  const P = E.createProject();
  P.roles = { cleaner: 'Alex', reviewer: 'Ben', manager: 'Mira', releaser: 'Alex' };
  E.ensureAccounts(P); for (const a of P.accounts) await E.setPassword(P, a.name, PW);
  const C = { name: 'Alex', role: 'cleaner' };
  E.updateProject(P, { name: 'Example Brand Survey', mode: 'CATI', target: '30', source: 'Example call centre', moeBasis: 'Quota sample by race × gender × age', qreVersion: 'QRE v1' }, C);
  const qb = new TextEncoder().encode('Example questionnaire');
  E.attachQre(P, { name: 'Example_QRE_v1.txt', size: qb.length, hash: await E.hash(qb), bytes64: IO.base64(qb) }, C);
  const rows = [['resp_id', 'age', 'race', 'gender', 'q1_aware', 'q2_source', 'q3_rating', 'q4_comment']];
  const comments = ['Good value', 'Ads are too loud', '', 'asdfgh', 'Like the new packaging', '', 'Would recommend', 'n/a', '', 'Seen it on TikTok'];
  for (let i = 1; i <= 30; i++) {
    const aware = i % 3 === 0 ? '2' : '1';
    rows.push(['R' + String(i).padStart(3, '0'), String(20 + (i * 7) % 50), String([1, 1, 2, 1, 3, 2, 4][i % 7]), i % 2 ? 'Male' : 'Female', aware, aware === '1' ? ['1', '1;3', '3', '2;4', '4'][i % 5] : '', String(1 + i % 5), comments[i % 10]]);
  }
  rows[4][1] = '150'; rows[6][3] = 'F '; rows[9][5] = '1;3'; rows[11][4] = ''; rows[13][5] = '1;99'; rows[15][6] = '7'; rows[17][1] = '16'; rows[20][0] = 'R019'; rows[22][6] = '98';
  const csv = rows.map(r => r.join(',')).join('\n');
  const bytes = new TextEncoder().encode(csv);
  const input = await IO.readInput({ name: 'example_responses.csv', size: bytes.length, arrayBuffer: async () => bytes.buffer }, {});
  IO.importDataset(P, input, 0, 1, {}, C, { receivedAt: E.now(), source: 'Example call centre', vendor: 'Batch 1 of 1' });
  const fields = E.clone(P.fields), set = (n, o) => Object.assign(fields.find(x => x.name === n), o);
  set('resp_id', { id: true, type: 'text', required: true });
  set('age', { type: 'integer', required: true, number: true, min: 15, max: 90, label: 'S1 Age' });
  set('race', { required: true, allowed: ['1', '2', '3', '4'], number: true, label: 'S2 Race' });
  set('gender', { required: true, allowed: ['1', '2'], trim: true, number: true, mappings: [{ from: 'Male', to: 1 }, { from: 'Female', to: 2 }, { from: 'F', to: 2 }, { from: 'M', to: 1 }], label: 'S3 Gender' });
  set('q1_aware', { required: true, allowed: ['1', '2'], number: true, label: 'Q1 Heard of Brand X?' });
  set('q2_source', { type: 'multi', required: true, allowed: ['1', '2', '3', '4', '99'], exclusive: ['99'], delimiter: ';', route: { field: 'q1_aware', op: 'eq', value: '1' }, label: 'Q2 Where heard (ask if Q1=1)' });
  set('q3_rating', { required: true, allowed: ['1', '2', '3', '4', '5'], missing: ['98'], number: true, label: 'Q3 Rating' });
  set('q4_comment', { type: 'text', label: 'Q4 Comments (open-ended)' });
  const derived = [
    { name: 'AGE_BAND', kind: 'band', source: 'age', bands: [{ min: 18, max: 29, label: '' }, { min: 30, max: 44, label: '' }, { min: 45, max: 59, label: '' }, { min: 60, max: null, label: '' }] },
    { name: 'RACE_EN', kind: 'label', source: 'race', labels: [{ from: '1', to: 'Malay' }, { from: '2', to: 'Chinese' }, { from: '3', to: 'Indian' }, { from: '4', to: 'Others' }] },
    { name: 'GENDER_EN', kind: 'label', source: 'gender', labels: [{ from: '1', to: 'Male' }, { from: '2', to: 'Female' }] },
    { name: 'SEGMENT', kind: 'combine', parts: ['RACE_EN', 'GENDER_EN', 'AGE_BAND'], sep: '|' }];
  E.updateRules(P, { fields, eligibility: { field: 'age', op: 'gte', value: '18' }, checks: [], derived, respNumber: true }, C);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-'));
  const zip = path.join(dir, 'Example_Brand_Survey.zip');
  fs.writeFileSync(zip, await IO.packageProject(P));
  return { zip, dir };
}

// ---------- 2. Drive the app in headless Chrome ----------
const { zip, dir } = await exampleProject();
const chromePath = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=9334', '--user-data-dir=' + path.join(dir, 'profile'), '--no-first-run', new URL('../dist/Survey_Cleaner.html', import.meta.url).href], { stdio: 'ignore' });
let targets; for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9334/json')).json(); if (targets.some(t => t.type === 'page')) break; } catch {} await sleep(250); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let seq = 0; const waiting = new Map(), pageErrors = [];
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params.exceptionDetails.exception?.description); };
const send = (method, params = {}) => new Promise(r => { const i = ++seq; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw Error(r.result.exceptionDetails.exception?.description || expr); return r.result.result.value; };
const q = s => JSON.stringify(s);
const click = async (sel, wait = 400) => { await ev(`(()=>{const e=document.querySelector(${q(sel)}); if(!e) throw Error('Not found: '+${q(sel)}); e.click(); return 1})()`); await sleep(wait); };
const clickText = async (sel, text, wait = 400) => { await ev(`(()=>{const e=[...document.querySelectorAll(${q(sel)})].find(x=>x.textContent.includes(${q(text)})); if(!e) throw Error('Not found: '+${q(text)}); e.click(); return 1})()`); await sleep(wait); };
const fill = (sel, v) => ev(`(()=>{const e=document.querySelector(${q(sel)}); if(!e) throw Error('Not found: '+${q(sel)}); if(e.type==='radio'||e.type==='checkbox') e.checked=${q(v)}; else e.value=${q(v)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
const out = here('src/guide/'); fs.mkdirSync(out, { recursive: true });
async function shot(name, sels, { maxH = 1e9, pad = 10 } = {}) {
  await ev('window.scrollTo(0,0)'); await sleep(200);
  const r = await ev(`(()=>{const rs=${q(sels)}.map(s=>{const e=document.querySelector(s); if(!e) throw Error('Not found: '+s); return e.getBoundingClientRect()}); return {x:Math.min(...rs.map(r=>r.left)),y:Math.min(...rs.map(r=>r.top)),r:Math.max(...rs.map(r=>r.right)),b:Math.max(...rs.map(r=>r.bottom))}})()`);
  const clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.r - r.x + 2 * pad, height: Math.min(r.b - r.y + 2 * pad, maxH), scale: 1 };
  const res = await send('Page.captureScreenshot', { format: 'webp', quality: 82, clip });
  fs.writeFileSync(out + name + '.webp', Buffer.from(res.result.data, 'base64'));
  console.log('  saved src/guide/' + name + '.webp');
}
async function signIn(name) { await click(`[data-act=pickLogin][data-name="${name}"]`, 300); await fill('#li_pw', PW); await click('[data-act=signIn]', 1500); }
const signOut = () => click('header [data-act=signOut]', 500);
const go = n => click(`nav [data-act=go][data-step="${n}"]`, 500);

try {
  await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 3200, deviceScaleFactor: 1.5, mobile: false });
  await sleep(1200);
  await ev(`(()=>{const s=document.createElement('style'); s.textContent='#toast{display:none!important}'; document.head.append(s); return 1})()`);
  // Open the example project through the real "Open a saved project" file input.
  const { root } = await send('DOM.getDocument').then(r => r.result);
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#project-input' }).then(r => r.result);
  await send('DOM.setFileInputFiles', { nodeId, files: [zip] }); await sleep(2500);

  console.log('Step 3 (cleaner)');
  await signIn('Alex'); await go(3);
  await shot('s3-questions', ['.row.toolbar', '.card:has(.tablewrap.rules)']);
  await click('[data-act=editField][data-fi="5"]'); await shot('s3-edit-question', ['#modal']); await click('#modal [data-act=closeModal]');
  await click('[data-act=editCheck][data-ci="-1"]');
  await fill('#ck_msg', "People who haven't heard of Brand X can't rate it, so Q3 should be 98 (Don't know)");
  await fill('#ck_when .b-field', 'q1_aware'); await fill('#ck_when .b-op', 'eq'); await fill('#ck_when .b-val', '2');
  await fill('#ck_expect .b-field', 'q3_rating'); await fill('#ck_expect .b-op', 'eq'); await fill('#ck_expect .b-val', '98');
  await shot('s3-check', ['#modal']); await click('#modal [data-act=closeModal]'); // example only; not saved

  await shot('s3-added', ['.card:has(#dv_resp)']);
  await click('[data-act=editDerived][data-di="0"]'); await shot('s3-col-band', ['#modal']); await click('#modal [data-act=closeModal]');
  await click('[data-act=editDerived][data-di="1"]'); await shot('s3-col-label', ['#modal']); await click('#modal [data-act=closeModal]');
  await signOut();

  console.log('Step 3 (manager approves)');
  await signIn('Mira'); await go(3);
  await fill('#ruleNote', 'Checked against QRE v1; routing for Q2 confirmed');
  await shot('s3-approve', ['.card:has(#ruleNote)']);
  await click('[data-act=approveRules]', 1000); await signOut();

  console.log('Step 4 (cleaner runs checks)');
  await signIn('Alex'); await go(4);
  await shot('s4-top', ['.tiles', '.row.toolbar']);
  await click('[data-act=runChecks]', 600); await shot('s4-run', ['#modal']);
  await click('[data-act=confirmOk]', 3000); await signOut();

  console.log('Step 4 (manager decides)');
  await signIn('Mira'); await go(4);
  await ev(`[...document.querySelectorAll('.isel')].slice(0,2).forEach(x=>{x.checked=true; x.dispatchEvent(new Event('change',{bubbles:true}))})`); await sleep(400);
  await shot('s4-issues', ['.tabs', '.card:has(#if_status)'], { maxH: 1050 });
  await ev(`[...document.querySelectorAll('.isel:checked')].forEach(x=>{x.checked=false; x.dispatchEvent(new Event('change',{bubbles:true}))})`); await sleep(400);
  await clickText('tr[data-act=openIssue]', 'Out of range', 600);
  await fill('input[name=dec][value=correct]', true);
  await fill('#dec_value', '50'); await fill('#dec_evidence', 'Callback on 14 Nov: respondent confirmed age 50');
  await fill('#dec_reason', 'Interviewer typing error'); await fill('#dec_ref', 'Callback log 14 Nov');
  await shot('s4-decision', ['#modal'], { maxH: 1250 });
  await click('[data-act=saveDecision]', 800); await signOut();

  console.log('Step 4 (cleaner applies and inspects)');
  await signIn('Alex'); await go(4);
  await shot('s4-apply', ['.row.toolbar [data-act=runChecks]', '.row.toolbar [data-act=downloadDraft]']);
  await click('[data-act=applyDecisions]', 1500);
  await click('[data-act=tab][data-tab=resp]', 500);
  await shot('s4-respondents', ['.tabs', '.card:has(#rf_filter)'], { maxH: 820 });
  await clickText('tr[data-act=openResp]', 'R004', 600);
  await shot('s4-respondent', ['#modal'], { maxH: 1300 });
  await click('#modal [data-act=closeModal]');
  await click('[data-act=tab][data-tab=changes]', 500);
  await shot('s4-changes', ['.tabs', '.tabs + .card'], { maxH: 560 });
} catch (e) { console.error('✗', e.message); process.exitCode = 1; }
if (pageErrors.length) { console.error('Page errors:', pageErrors); process.exitCode = 1; }
ws.close(); chrome.kill(); await new Promise(r => chrome.once('exit', r)); await sleep(500);
fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
