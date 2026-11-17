// Builds one self-contained offline HTML file: node build.mjs
import { readFileSync, writeFileSync, mkdirSync, mkdirSync as mkdir, copyFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const safe = js => js.replace(/<\/(script)/gi, '<\\/$1');
const scripts = {
  __XLSX__: safe(read('./vendor/xlsx.full.min.js')),
  __FFLATE__: safe(read('./vendor/fflate.min.js')),
  __ENGINE__: safe(read('./src/engine.js')),
  __IO__: safe(read('./src/io.js')),
  __APP__: safe(read('./src/app.js'))
};
const hashes = Object.values(scripts).map(s => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`).join(' ');
const b64 = p => readFileSync(new URL(p, import.meta.url)).toString('base64');
const font = (family, file, weight) => `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${b64('./vendor/fonts/' + file)}) format("woff2")}`;
const fonts = [font('Schibsted Grotesk', 'SchibstedGrotesk-latin.woff2', '600 800'), font('Public Sans', 'PublicSans-latin.woff2', '400 700'),
  font('IBM Plex Mono', 'IBMPlexMono-400-latin.woff2', '400'), font('IBM Plex Mono', 'IBMPlexMono-500-latin.woff2', '500')].join('\n');
const logo = 'data:image/png;base64,' + b64('./vendor/logo-mark.png');
const styles = read('./src/styles.css').replace('__FONTS__', () => fonts).replace('__LOGO__', () => logo);
const csp = `default-src 'none'; script-src ${hashes}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`;
let html = read('./src/shell.html').replace('__CSP__', csp).replace('__STYLES__', () => styles).replace('__FAVICON__', () => logo);
for (const [k, v] of Object.entries(scripts)) html = html.replace(k, () => v);
mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('./dist/Survey_Cleaner.html', import.meta.url), html);
for (const f of ['SheetJS-LICENSE.txt', 'fflate-LICENSE.txt']) copyFileSync(new URL('./vendor/' + f, import.meta.url), new URL('./dist/' + f, import.meta.url));
for (const f of readdirSync(new URL('./vendor/fonts/', import.meta.url)).filter(f => f.startsWith('OFL-'))) copyFileSync(new URL('./vendor/fonts/' + f, import.meta.url), new URL('./dist/' + f, import.meta.url));
copyFileSync(new URL('./QUICK_START.txt', import.meta.url), new URL('./dist/QUICK_START.txt', import.meta.url));
// GitHub Pages copy: publish from the /docs folder.
mkdir(new URL('./docs/', import.meta.url), { recursive: true });
writeFileSync(new URL('./docs/index.html', import.meta.url), html);
writeFileSync(new URL('./docs/.nojekyll', import.meta.url), '');
console.log('Built dist/Survey_Cleaner.html and docs/index.html', (html.length / 1024).toFixed(0) + ' KB');
