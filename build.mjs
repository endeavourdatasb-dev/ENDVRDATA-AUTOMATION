// Builds one self-contained offline HTML file.
//   node build.mjs          build once
//   node build.mjs --watch  rebuild automatically every time a file in src/ or vendor/ is saved
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';

const url = p => new URL(p, import.meta.url);
const read = p => readFileSync(url(p), 'utf8');
const b64 = p => readFileSync(url(p)).toString('base64');
const safe = js => js.replace(/<\/(script)/gi, '<\\/$1');

function build() {
  // Check our own scripts for syntax errors first, so a typo never replaces a working page.
  for (const f of ['engine.js', 'io.js', 'app.js']) {
    try { new Script(read('./src/' + f), { filename: 'src/' + f }); }
    catch (e) {
      const where = (e.stack || '').split('\n')[0];
      throw new Error(`Syntax error in ${where || 'src/' + f}: ${e.message}. The page was not updated.`);
    }
  }
  const scripts = {
    __XLSX__: safe(read('./vendor/xlsx.full.min.js')),
    __FFLATE__: safe(read('./vendor/fflate.min.js')),
    __ENGINE__: safe(read('./src/engine.js')),
    __IO__: safe(read('./src/io.js')),
    __APP__: safe(read('./src/app.js'))
  };
  const hashes = Object.values(scripts).map(s => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`).join(' ');
  const font = (family, file, weight) => `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${b64('./vendor/fonts/' + file)}) format("woff2")}`;
  const fonts = [font('Schibsted Grotesk', 'SchibstedGrotesk-latin.woff2', '600 800'), font('Public Sans', 'PublicSans-latin.woff2', '400 700'),
    font('IBM Plex Mono', 'IBMPlexMono-400-latin.woff2', '400'), font('IBM Plex Mono', 'IBMPlexMono-500-latin.woff2', '500')].join('\n');
  const logo = 'data:image/png;base64,' + b64('./vendor/logo-mark.png');
  const styles = read('./src/styles.css').replace('__FONTS__', () => fonts).replace('__LOGO__', () => logo);
  const csp = `default-src 'none'; script-src ${hashes}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`;
  // The guide (src/guide.html) is inlined as a <template>; its screenshots in src/guide/ become data URIs.
  const guide = read('./src/guide.html').replace(/src="guide\/([\w-]+\.(webp|png|jpg))"/g, (_, f, ext) => `src="data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${b64('./src/guide/' + f)}"`);
  let html = read('./src/shell.html').replace('__CSP__', csp).replace('__STYLES__', () => styles).replace('__FAVICON__', () => logo).replace('__GUIDE__', () => guide);
  for (const [k, v] of Object.entries(scripts)) html = html.replace(k, () => v);

  mkdirSync(url('./dist/'), { recursive: true });
  writeFileSync(url('./dist/Survey_Cleaner.html'), html);
  for (const f of ['SheetJS-LICENSE.txt', 'fflate-LICENSE.txt']) copyFileSync(url('./vendor/' + f), url('./dist/' + f));
  for (const f of readdirSync(url('./vendor/fonts/')).filter(f => f.startsWith('OFL-'))) copyFileSync(url('./vendor/fonts/' + f), url('./dist/' + f));
  copyFileSync(url('./QUICK_START.txt'), url('./dist/QUICK_START.txt'));
  // GitHub Pages copy: published from the /docs folder.
  mkdirSync(url('./docs/'), { recursive: true });
  writeFileSync(url('./docs/index.html'), html);
  writeFileSync(url('./docs/.nojekyll'), '');
  return (html.length / 1024).toFixed(0) + ' KB';
}

const time = () => new Date().toLocaleTimeString();

if (!process.argv.includes('--watch')) {
  try { console.log('Built dist/Survey_Cleaner.html and docs/index.html', build()); }
  catch (e) { console.error('✗ ' + e.message); process.exitCode = 1; }
} else {
  const run = why => {
    try { console.log(`✓ ${time()}  Rebuilt${why ? ' (' + why + ')' : ''}, ${build()}. Refresh the browser to see it.`); }
    catch (e) { console.error(`✗ ${time()}  ${e.message}`); }
  };
  run();
  let timer = null, changed = new Set();
  for (const dir of ['./src/', './vendor/']) {
    watch(url(dir), { recursive: true }, (event, file) => {
      if (!file || file.startsWith('.') || file.endsWith('~')) return;
      changed.add(dir.slice(2) + file);
      clearTimeout(timer);
      timer = setTimeout(() => { const list = [...changed].join(', '); changed.clear(); run(list); }, 150);
    });
  }
  watch(url('./QUICK_START.txt'), () => { clearTimeout(timer); timer = setTimeout(() => run('QUICK_START.txt'), 150); });
  console.log('Watching src/, vendor/ and QUICK_START.txt. Save a file to rebuild. Press Ctrl+C to stop.');
}
