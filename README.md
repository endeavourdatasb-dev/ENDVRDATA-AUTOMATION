# Survey Cleaner

An offline, single-file browser app for checking, cleaning, independently verifying and releasing survey datasets. It follows the Endeavour DATA cleaning, verification and release procedure (SOP 03), with fixed rules in place of AI.

- **Runs in the browser.** Survey files are processed on the user's computer and never uploaded. The page's security policy blocks all network connections.
- **No AI, no guessing.** Every check and correction follows rules that a manager approves. Missing answers are never filled in.
- **Built-in controls.** Separate cleaner, independent reviewer, manager and releasing analyst roles; a full change log; and release blocked until review and approval are done.

## Use it
- **Online:** open the GitHub Pages link for this repository (Settings → Pages).
- **Offline:** download `docs/index.html`, rename it `Survey_Cleaner.html` if you like, and double-click it. It works in Chrome or Edge with no installation and no internet.
- Click **How to use (guide)** on the start page for a short step-by-step guide with screenshots. It is also under **Guide** inside every project. See also [QUICK_START.txt](QUICK_START.txt).

## Build
Requires [Node.js](https://nodejs.org) 18 or newer. There is no `npm install`; the libraries are in `vendor/`.
```
node build.mjs
```
This writes `docs/index.html` (published by GitHub Pages) and `dist/Survey_Cleaner.html` (a copy to share, not committed). After changing anything in `src/`, rebuild and commit `docs/index.html`.

If you change step 3 or step 4 screens, refresh the guide screenshots too:
```
node build.mjs && node tools/guide-screenshots.mjs && node build.mjs
```

While editing, use watch mode. It rebuilds every time you save a file in `src/` or `vendor/`; then refresh the browser. If a script has a syntax error, it says where and leaves the last working page in place.
```
node build.mjs --watch      # press Ctrl+C to stop
```

## Code layout
| File | What it does |
|---|---|
| `src/engine.js` | Rules and checks, standard raw-data checks, decisions, role controls, sign-offs, checksums. No user interface. |
| `src/io.js` | Reading .xlsx/.xls/.ods/.csv/.tsv/.txt/.json, Excel export, project packages (.zip), rules templates |
| `src/app.js` | The screens: the guided 7-step flow and sign-in |
| `src/guide.html`, `src/guide/` | The in-app guide and its screenshots (inlined into the HTML at build time) |
| `tools/guide-screenshots.mjs` | Regenerates the guide screenshots from a made-up example project. Needs Google Chrome |
| `src/styles.css`, `src/shell.html` | Look and page shell |
| `build.mjs` | Combines everything, including the fonts and logo, into one HTML file and adds the security policy |

## How it works (short)
- **Rules are data, not code.** Each question's codes, type, range, required flag and skip logic are stored as simple JSON conditions and checked by fixed functions in `engine.js`. A condition is true, false or "can't tell"; "can't tell" is flagged, never guessed.
- **Added columns** (step 3) are new output columns calculated from the answers: number bands (e.g. age bands), code → label tables (e.g. English race/gender labels) and combined keys (e.g. a race × gender × age segment). They are part of the approved rules, are recalculated from the current answers rather than stored, and never change the original columns. A value with no band or label is left blank and flagged for a manager decision.
- **Resp #** (on by default) is the respondent's row number in the raw file. It is the first column of the cleaned data and appears on the excluded and record-status sheets, so every row can be traced back.
- **Standard raw-data checks** run on every file: IDs, empty and duplicate rows, Excel-damaged numbers, spreadsheet errors, formulas, garbled text, empty columns, mixed types, stray spaces, mostly blank respondents and straight-lining.
- **Accounts** live inside each project file. Passwords are stored as salted PBKDF2-SHA256 hashes. These are recorded attestations, not strong security: anyone with the project file and technical skill could get around them.
- **Integrity.** Originals are kept byte-for-byte with SHA-256 checksums. Saved projects are checked for tampering when opened, and any change after review or approval cancels the sign-offs.

## Limits
- Up to 10,000 respondents and 500 columns per file, and 25 MB per file.
- SPSS .sav, password-protected and macro-enabled files are not supported.
- Tested in Chrome on macOS.

## Third-party components
- [SheetJS Community Edition](https://sheetjs.com) 0.20.3, Apache-2.0 (`vendor/SheetJS-LICENSE.txt`)
- [fflate](https://github.com/101arrowz/fflate), MIT (`vendor/fflate-LICENSE.txt`)
- Fonts: Schibsted Grotesk, Public Sans and IBM Plex Mono, SIL Open Font License 1.1 (`vendor/fonts/OFL-*.txt`)

The Endeavour DATA name and logo belong to Endeavour DATA.
