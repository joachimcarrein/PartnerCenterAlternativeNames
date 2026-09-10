/* Zero-dependency loader for the extension's IIFE modules.
 *
 * The runtime files ARE the shipped files — no build step, no module system
 * (see CLAUDE.md, Repository conventions), so every one of them is a bare
 * `(() => { ... })()` with nothing exported. Tests therefore cannot require()
 * them, and adding test-only `module.exports` footers to shipped code was
 * rejected: search-inject.js runs in the page's MAIN world, where a stray
 * global `module` left behind by the page's own bundler could make such a
 * footer do something unintended.
 *
 * Instead this strips the IIFE wrapper and runs the body as a plain Script in
 * a vm context seeded with stub browser globals. Two facts make that work:
 *
 *   - Top-level `function` declarations in a Script become properties of that
 *     context's global object, even under 'use strict' (strict mode only
 *     changes this for *block*-level declarations). So the functions come back
 *     out on their own.
 *   - Top-level `const`/`let` do NOT. They stay lexical. The functions close
 *     over them fine, but to read a constant (MAX_ENTRIES, FORMAT_TYPE, ...)
 *     a test must ask for it via `expose`, which is appended to the same
 *     source string and therefore shares that lexical scope.
 *
 * The only coupling to source formatting is the wrapper's first and last line,
 * which is far more stable than extracting individual functions by regex. If
 * this ever becomes a maintenance burden, the fallback is a
 * `if (typeof module !== 'undefined' && typeof window === 'undefined')` footer
 * in each file.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');

const IIFE_OPEN = '(() => {';
const IIFE_CLOSE = '})();';

function stripIife(src, file) {
  const open = src.indexOf(IIFE_OPEN);
  if (open === -1) throw new Error(`${file}: no "${IIFE_OPEN}" wrapper found.`);
  const close = src.lastIndexOf(IIFE_CLOSE);
  if (close === -1 || close < open) throw new Error(`${file}: no "${IIFE_CLOSE}" wrapper found.`);
  return src.slice(open + IIFE_OPEN.length, close);
}

/* Load one runtime file into an isolated sandbox.
 *
 *   file    - repo-relative, e.g. 'src/popup.js'
 *   globals - browser globals the file touches at load time
 *   expose  - JS snippet appended inside the module scope; use it to publish
 *             lexical `const`s onto globalThis, e.g.
 *             'globalThis.MAX = MAX_ENTRIES;'
 *
 * Returns the sandbox, which carries the module's top-level functions plus
 * whatever `expose` published.
 */
function loadIife(file, globals = {}, expose = '') {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const body = stripIife(src, file);

  // Only HOST globals go in. A fresh vm context already owns every
  // ECMAScript intrinsic (Object, JSON, Date, Promise, ...) in its own realm;
  // injecting the outer realm's versions on top would mix realms and make
  // `instanceof` unreliable inside the module.
  const sandbox = {
    // Silenced by default: both files log verbosely under their DEBUG flag.
    console: { log() {}, warn() {}, error() {} },
    URL,
    setTimeout,
    clearTimeout,
    ...globals,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(body + '\n;' + expose, sandbox, { filename: file });
  return sandbox;
}

module.exports = { loadIife, stripIife, ROOT };
