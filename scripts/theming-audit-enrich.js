#!/usr/bin/env node
'use strict';

// theming-audit-enrich.js — Phase 0 post-Track-B: enrich the audit with
// proposedTokenName + confidence per match, so Migration has pre-assigned
// targets.
//
// Scope (per user decision 2026-04-19):
//   Color-only enrichment. Only matches with kind ∈ {hex, rgba, named,
//   gradient-*} are enriched. chrome-dimension matches (851 total) are
//   NOT included in the enriched JSON and are summarised separately in
//   theming-dimension-analysis.md for the future spacing-scale track.
//
// Confidence tiers:
//   high            — rule-based, unambiguous catalog match
//   medium          — rule-based, some ambiguity (state/variant/composite)
//   low             — keyword-scored judgment step; rationale required
//   no-fit          — no catalog token fits → feeds catalog-gap report
//   false-positive  — matched string is not a real color literal (parser
//                     helper, hex→rgb converter, etc.) → NOT a gap
//
// Outputs:
//   scripts/theming-audit-enriched.json
//   scripts/theming-enrichment-review.md
//   scripts/theming-catalog-gaps.md
//   scripts/theming-dimension-analysis.md

const fs        = require('fs');
const path      = require('path');
const { execSync } = require('child_process');

// ──────────────────────────────────────────────────────────────────────────
// 1. Load audit
// ──────────────────────────────────────────────────────────────────────────

const ROOT        = path.resolve(__dirname, '..');
const AUDIT_PATH  = path.resolve(__dirname, 'theming-audit-output.json');
const audit       = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));

// ──────────────────────────────────────────────────────────────────────────
// 2. Load catalog via esbuild
// ──────────────────────────────────────────────────────────────────────────

function loadCatalog() {
  const catalogTs = path.resolve(ROOT, 'ui/src/theming/tokens/catalog.ts');
  const tmpDir    = path.resolve(ROOT, 'ui/node_modules/.theming-verify-cache');
  const tmpFile   = path.join(tmpDir, 'catalog.cjs');
  fs.mkdirSync(tmpDir, { recursive: true });
  execSync(
    `node -e "require('esbuild').buildSync({entryPoints:['${catalogTs.replace(/\\/g, '/')}'],bundle:false,format:'cjs',outfile:'${tmpFile.replace(/\\/g, '/')}',platform:'node'})"`,
    { cwd: path.resolve(ROOT, 'ui'), stdio: 'pipe' }
  );
  delete require.cache[tmpFile];
  return require(tmpFile);
}
const catalog = loadCatalog();
const TOKENS         = catalog.TOKENS;
const SUBSYSTEMS     = catalog.SUBSYSTEMS;
const TOKENS_BY_NAME = catalog.TOKENS_BY_NAME;

// Subsystem → tokens map, color-kind only
const tokensBySub = new Map();
for (const t of TOKENS) {
  if (t.kind !== 'color') continue;
  if (!tokensBySub.has(t.subsystem)) tokensBySub.set(t.subsystem, []);
  tokensBySub.get(t.subsystem).push(t);
}

// Value-direct lookup index for explicit-value color tokens.
// Used by the label-color re-subsystem pass: normalized hex → tokenName.
const explicitValueIndex = new Map();
for (const t of TOKENS) {
  if (t.kind === 'color' && t.derivation && t.derivation.type === 'explicit') {
    explicitValueIndex.set(t.derivation.value.toLowerCase(), t.name);
  }
}

// Subsystem alias map (e.g. 'chrome-layout' → 'panel-chrome')
const aliasMap = new Map();
for (const s of SUBSYSTEMS) {
  if (Array.isArray(s.aliases)) for (const a of s.aliases) aliasMap.set(a, s.key);
}
const resolveSlug = s => aliasMap.get(s) || s;

// Canonical subsystem set
const CANONICAL_SUBS = new Set(SUBSYSTEMS.map(s => s.key));

// ──────────────────────────────────────────────────────────────────────────
// 3. Flatten audit → color matches only
// ──────────────────────────────────────────────────────────────────────────

function isColorKind(kind) {
  return kind === 'hex' || kind === 'rgba' || kind === 'named'
      || (typeof kind === 'string' && kind.startsWith('gradient'));
}

const allMatches = [];
let originalMatchIndex = 0;
for (const [subKey, data] of Object.entries(audit.bySubsystem)) {
  for (const f of (data.files || [])) {
    for (const m of (f.matches || [])) {
      allMatches.push({
        ...m,
        subsystem: subKey,   // original (may be 'chrome-layout')
        path: f.path,
        _auditIdx: originalMatchIndex++,
      });
    }
  }
}

const colorMatches     = allMatches.filter(m => isColorKind(m.kind));
const dimensionMatches = allMatches.filter(m => m.kind === 'chrome-dimension');

console.log(`Loaded ${allMatches.length} total audit matches.`);
console.log(`  color matches     : ${colorMatches.length}  (scope of this enrichment)`);
console.log(`  dimension matches : ${dimensionMatches.length}  (deferred — see theming-dimension-analysis.md)`);

// ──────────────────────────────────────────────────────────────────────────
// 4. Selector-prefix dispatcher for chrome-layout (app.css) matches
//
// Reads app.css once, builds a line → selector index, then maps selectors
// to a concrete subsystem via prefix rules. Mutates the match's subsystem
// field on the enriched output.
// ──────────────────────────────────────────────────────────────────────────

const APP_CSS_PATH = path.resolve(ROOT, 'ui/src/styles/app.css');
const APP_CSS_RAW  = fs.readFileSync(APP_CSS_PATH, 'utf8');
const APP_CSS_LINES = APP_CSS_RAW.split(/\r?\n/);

// Build array of { startLine, endLine, selector } by naive brace-tracking.
// Every time we see `SELECTOR {` at top level we open a block; matching
// `}` closes it. Only top-level blocks count (nesting is rare in this CSS).
function buildCssBlockIndex(lines) {
  const blocks = [];
  let depth = 0;
  let currentSelector = null;
  let currentStart = null;
  let pendingSelectorLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (depth === 0) {
      // Skip comment / at-rule-only lines
      const isIgnore = trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//');
      if (isIgnore) continue;

      const openIdx = trimmed.indexOf('{');
      if (openIdx >= 0) {
        // Selector is the accumulated pending lines + this line's prefix up to `{`
        const selectorRaw = (pendingSelectorLines.join(' ') + ' ' + trimmed.slice(0, openIdx)).trim();
        currentSelector = selectorRaw;
        currentStart = i + 1; // 1-based
        pendingSelectorLines = [];
        // Count braces on the rest of this line — may include a closing `}`
        depth = 1;
        for (let k = openIdx + 1; k < trimmed.length; k++) {
          if (trimmed[k] === '{') depth++;
          else if (trimmed[k] === '}') {
            depth--;
            if (depth === 0) {
              blocks.push({ startLine: currentStart, endLine: i + 1, selector: currentSelector });
              currentSelector = null;
              currentStart = null;
              break;
            }
          }
        }
      } else if (!trimmed.startsWith('@')) {
        // Multi-line selector accumulator (e.g. .a, .b, .c  { )
        pendingSelectorLines.push(trimmed);
      }
    } else {
      // Inside a block — count braces simply (strings/comments ignored; CSS
      // rarely has nested braces anyway).
      for (const ch of trimmed) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            blocks.push({
              startLine: currentStart,
              endLine:   i + 1,
              selector:  currentSelector,
            });
            currentSelector = null;
            currentStart = null;
            break;
          }
        }
      }
    }
  }
  return blocks;
}

const APP_CSS_BLOCKS = buildCssBlockIndex(APP_CSS_LINES);

// Given a 1-based line number, return the innermost (in practice, the only)
// block containing it, or null.
function findBlockForLine(lineNo) {
  // Blocks are in source order, non-overlapping — linear scan is fine.
  // Optimisation left for later; N≈several hundred.
  for (const b of APP_CSS_BLOCKS) {
    if (lineNo >= b.startLine && lineNo <= b.endLine) return b;
  }
  return null;
}

// Selector prefix → canonical subsystem. Order matters: first regex hit wins.
// Prefix is the first `.xxx-yyy` segment. We check the whole selector, so
// multi-selector rules like `.a, .b { }` dispatch on the FIRST class.
const DISPATCH_RULES = [
  // context-menus — must come before buttons-like prefixes
  { re: /^\.context(-|\b)/,              target: 'context-menus' },

  // dialogs / modals / toasts / misc modals
  { re: /^\.toast(-|\b)/,                target: 'dialogs-modals' },
  { re: /^\.confirm(-|\b)/,              target: 'dialogs-modals' },
  { re: /^\.unsaved(-|\b)/,              target: 'dialogs-modals' },
  { re: /^\.quantize(-|\b)/,             target: 'dialogs-modals' },
  { re: /^\.export(-|\b)/,               target: 'dialogs-modals' },
  { re: /^\.missing(-|\b)/,              target: 'dialogs-modals' },
  { re: /^\.settings(-|\b)/,             target: 'dialogs-modals' },
  { re: /^\.scan(-|\b)/,                 target: 'dialogs-modals' },

  // transport bar
  { re: /^\.transport(-|\b)/,            target: 'transport-bar' },

  // timeline (incl. its sub-pieces)
  { re: /^\.timeline(-|\b)/,             target: 'timeline' },
  { re: /^\.track(-|\b)/,                target: 'timeline' },
  { re: /^\.marked-sample(-|\b)/,        target: 'timeline' },
  { re: /^\.waveform(-|\b)/,             target: 'timeline' },

  // piano roll
  { re: /^\.piano(-|\b)/,                target: 'piano-roll' },

  // pattern list
  { re: /^\.pattern(-|\b)/,              target: 'pattern-list' },

  // sampler (panel-level chrome; individual sub-editors use JSX inline)
  { re: /^\.sampler(-|\b)/,              target: 'sampler' },

  // sample selector / picker
  { re: /^\.sample(-|\b)/,               target: 'sample-selector' },
  { re: /^\.source-card(-|\b)/,          target: 'sample-selector' },
  { re: /^\.picker(-|\b)/,               target: 'sample-selector' },

  // grid editor
  { re: /^\.grid(-|\b)/,                 target: 'grid-editor' },

  // mixer & effect chain chrome
  { re: /^\.mixer(-|\b)/,                target: 'mixer' },
  { re: /^\.effect(-|\b)/,               target: 'mixer' },

  // stock effects by plugin name
  { re: /^\.eq(-|\b)/,                   target: 'stock-effects.eq' },
  { re: /^\.compressor(-|\b)/,           target: 'stock-effects.dynamics' },
  { re: /^\.limiter(-|\b)/,              target: 'stock-effects.dynamics' },
  { re: /^\.ott(-|\b)/,                  target: 'stock-effects.dynamics' },
  { re: /^\.transientproc(-|\b)/,        target: 'stock-effects.dynamics' },
  { re: /^\.sb(-|\b)/,                   target: 'stock-effects.dynamics' },
  { re: /^\.chorus(-|\b)/,               target: 'stock-effects.modulation' },
  { re: /^\.flanger(-|\b)/,              target: 'stock-effects.modulation' },
  { re: /^\.phaser(-|\b)/,               target: 'stock-effects.modulation' },
  { re: /^\.delay(-|\b)/,                target: 'stock-effects.time' },
  { re: /^\.reverb(-|\b)/,               target: 'stock-effects.time' },
  { re: /^\.distortion(-|\b)/,           target: 'stock-effects.distortion' },
  { re: /^\.ws(-|\b)/,                   target: 'stock-effects.distortion' },

  // node editor
  { re: /^\.ne(-|\b)/,                   target: 'node-editor' },
  { re: /^\.node(-|\b)/,                 target: 'node-editor' },

  // syllable splitter
  { re: /^\.syllable(-|\b)/,             target: 'syllable-splitter' },

  // preview player
  { re: /^\.video(-|\b)/,                target: 'preview-player' },
  { re: /^\.preview(-|\b)/,              target: 'preview-player' },

  // project media / VST browser
  { re: /^\.vst(-|\b)/,                  target: 'project-media' },

  // panel-chrome — titlebar, app shell, tabs, left-panel
  { re: /^\.titlebar(-|\b)/,             target: 'panel-chrome' },
  { re: /^\.app(-|\b)|^\.app\b/,         target: 'panel-chrome' },
  { re: /^\.resizable(-|\b)/,            target: 'panel-chrome' },
  { re: /^\.left-panel(-|\b)/,           target: 'panel-chrome' },
  { re: /^\.center-area(-|\b)/,          target: 'panel-chrome' },
  { re: /^\.tab(-|\b)/,                  target: 'panel-chrome' },
];

function dispatchSelector(selector) {
  if (!selector) return null;
  // Use first class in multi-selector rule
  const first = selector.split(/[,]/)[0].trim();
  for (const rule of DISPATCH_RULES) {
    if (rule.re.test(first)) return rule.target;
  }
  return null;
}

// Apply to every chrome-layout color match, mutate subsystem field.
const dispatchStats = { unmatched: 0 };
for (const m of colorMatches) {
  if (m.subsystem === 'chrome-layout') {
    const block = findBlockForLine(m.line);
    const target = block ? dispatchSelector(block.selector) : null;
    if (target) {
      m.subsystem = target;
      m._dispatchedFrom = 'chrome-layout';
      m._dispatchSelector = block.selector;
      dispatchStats[target] = (dispatchStats[target] || 0) + 1;
    } else {
      m._dispatch = 'unmatched';
      m._dispatchSelector = block ? block.selector : null;
      dispatchStats.unmatched++;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 5. Helpers to parse surroundingContext robustly
//
// Context format:
//     58:   foo = bar
//     59:   baz
//  >  60:   padding: 6px;
//     61: }
//
// strip `>` marker + ` LINE:` prefix so regexes can operate cleanly.
// ──────────────────────────────────────────────────────────────────────────

function parseContextLines(ctx) {
  if (!ctx) return { lines: [], matchLine: '', before: [], after: [] };
  const raw = ctx.split(/\r?\n/);
  const parsed = [];
  for (const l of raw) {
    // Strip leading `>   ` marker if present, then strip `   LINE:` prefix
    let cleaned = l.replace(/^\s*>\s*/, '');
    cleaned = cleaned.replace(/^\s*\d+\s*:\s*/, '');
    parsed.push({ raw: l, text: cleaned, marked: /^\s*>/.test(l) });
  }
  const matchLine = (parsed.find(p => p.marked) || { text: '' }).text;
  const markedIdx = parsed.findIndex(p => p.marked);
  const before = markedIdx >= 0 ? parsed.slice(0, markedIdx).map(p => p.text) : [];
  const after  = markedIdx >= 0 ? parsed.slice(markedIdx + 1).map(p => p.text) : [];
  return { lines: parsed.map(p => p.text), matchLine, before, after };
}

// ──────────────────────────────────────────────────────────────────────────
// 6. Role extraction: given a CSS property or CSS-in-JS key, pick a role
// ──────────────────────────────────────────────────────────────────────────

const CSS_PROP_PATTERNS = [
  { re: /background(-color)?\s*:/i,     role: 'bg' },
  { re: /\bcolor\s*:/i,                 role: 'fg' },
  { re: /border(-color|-top|-bottom|-left|-right)?\s*:/i, role: 'border' },
  { re: /(box-shadow|filter)\s*:/i,     role: 'shadow' },
  { re: /outline(-color)?\s*:/i,        role: 'outline' },
  { re: /\bfill\s*:/i,                  role: 'fill' },
  { re: /\bstroke\s*:/i,                role: 'stroke' },
  { re: /accent-color\s*:/i,            role: 'accent' },
  { re: /caret-color\s*:/i,             role: 'fg' },
  { re: /text-decoration(-color)?\s*:/i, role: 'fg' },
];

const JSX_KEY_PATTERNS = [
  { re: /\bbackgroundColor\s*:/,        role: 'bg' },
  { re: /\bbackground\s*:/,             role: 'bg' },
  { re: /\bborderColor\s*:/,            role: 'border' },
  { re: /\bborder(Top|Bottom|Left|Right)?(Color|Width|Style)?\s*:/, role: 'border' },
  { re: /\bboxShadow\s*:/,              role: 'shadow' },
  { re: /\boutline(Color)?\s*:/,        role: 'outline' },
  { re: /\bfill\s*:/,                   role: 'fill' },
  { re: /\bstroke\s*:/,                 role: 'stroke' },
  { re: /\baccentColor\s*:/,            role: 'accent' },
  { re: /\bcaretColor\s*:/,             role: 'fg' },
  { re: /\bcolor\s*:/,                  role: 'fg' },
];

// Canvas 2D context and SVG-attribute patterns — extra JS contexts beyond
// CSS-in-JS. These are extremely common in our drawing code.
const CANVAS_SVG_PATTERNS = [
  { re: /\b(ctx|context)\.fillStyle\s*=/,    role: 'fill' },
  { re: /\b(ctx|context)\.strokeStyle\s*=/,  role: 'stroke' },
  { re: /\b(ctx|context)\.shadowColor\s*=/,  role: 'shadow' },
  { re: /\.addColorStop\s*\(/,               role: 'fill' },      // gradient stop — treat as a fill-ish color
  { re: /\bfill\s*=\s*["'{]/,                role: 'fill' },      // SVG JSX attr: fill="..."
  { re: /\bstroke\s*=\s*["'{]/,              role: 'stroke' },    // SVG JSX attr
];

// Destructuring defaults in JSX props / function signatures:
//   ({ color = '#33CED6', background = '#0a0a10' }) => ...
// Pattern:  <word>\s*=\s*['"`]#... or rgba(
const DESTRUCTURE_DEFAULT_PATTERNS = [
  { re: /\b(color|fg|foreground)\s*=\s*['"`]/,          role: 'fg' },
  { re: /\b(background|backgroundColor|bg)\s*=\s*['"`]/, role: 'bg' },
  { re: /\b(border|borderColor)\s*=\s*['"`]/,            role: 'border' },
  { re: /\b(fill|fillColor)\s*=\s*['"`]/,                role: 'fill' },
  { re: /\b(stroke|strokeColor)\s*=\s*['"`]/,            role: 'stroke' },
];

// Named-constant / local-variable color definitions:
//   const FOO_COLOR = '#33CED6'
//   const KNOB_COLOR = '#33CED6'
//   const BAND_COLORS = ['#33CED6', ...]
//   const lineColor = selected ? 'rgba(...)' : 'rgba(...)'
// The variable name carries role/element info we can feed to the scorer.
const CONST_DEF_PATTERNS = [
  { re: /^\s*(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/, role: 'constant' },
];

// Map hint-strings (from audit's elementHint or var-name suffix) to a role.
function roleFromHint(hint) {
  if (!hint) return null;
  const h = String(hint).toLowerCase();
  if (/(^|[-_ ])(canvas-)?fill$|fill(color)?$|^fill/.test(h)) return 'fill';
  if (/(^|[-_ ])(canvas-)?stroke$|stroke(color)?$|^stroke/.test(h)) return 'stroke';
  if (/(^|[-_ ])bg$|background$/.test(h)) return 'bg';
  if (/(^|[-_ ])fg$|foreground$|textcolor$/.test(h)) return 'fg';
  if (/(^|[-_ ])border$/.test(h)) return 'border';
  if (/(^|[-_ ])outline$/.test(h)) return 'outline';
  if (/(^|[-_ ])shadow$/.test(h)) return 'shadow';
  if (/gradient(-stop)?$/.test(h)) return 'fill';
  if (/linecolor$|strokecolor$/.test(h)) return 'stroke';
  if (/tracefill$|canvasfill$/.test(h)) return 'fill';
  return null;
}

function findRole(line, patterns) {
  for (const p of patterns) if (p.re.test(line)) return p.role;
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// 7. Token suffix → role heuristic (for matching subsystem tokens by role)
// ──────────────────────────────────────────────────────────────────────────

function tokenRole(tokenName) {
  // Look at trailing segment first, then second-to-last
  const segs = tokenName.replace(/^--theme-/, '').split('-');
  const last = segs[segs.length - 1];
  const prev = segs[segs.length - 2];
  if (last === 'bg' || last === 'background') return 'bg';
  if (last === 'fg' || last === 'color' || last === 'text' || last === 'label') return 'fg';
  if (last === 'border') return 'border';
  if (last === 'shadow') return 'shadow';
  if (last === 'outline') return 'outline';
  if (last === 'fill') return 'fill';
  if (last === 'stroke') return 'stroke';
  if (last === 'handle' || last === 'thumb' || last === 'track') return 'component';
  // `-hover-bg` etc. — take prev
  if (prev === 'bg') return 'bg';
  if (prev === 'fg' || prev === 'color') return 'fg';
  if (prev === 'border') return 'border';
  return 'other';
}

// ──────────────────────────────────────────────────────────────────────────
// 8. False-positive detector (conservative)
// ──────────────────────────────────────────────────────────────────────────

const FP_FILE_RE = /(^|[\\/])([^\\/]*[Uu]til[^\\/]*|[^\\/]*[Pp]arser[^\\/]*|color[A-Za-z]*\.js)$/;

function tryFalsePositive(m) {
  const pathMatchesHelper = FP_FILE_RE.test(m.path);
  const ctx = parseContextLines(m.surroundingContext);
  const near = [ctx.matchLine, ...ctx.before, ...ctx.after].join(' ');

  // Signal 1: the match is the bare token `rgba(` or `#` without a closing
  // paren / full literal on the same/adjacent line — suggests a helper.
  const bareRgbaCall = m.matchedText === 'rgba(' || m.matchedText === 'rgb(';
  // Signal 2: surrounding context contains parseInt(.*slice|.*substring|.*parseInt
  // — hex-string parsing helpers (PianoRollCanvas.jsx:15-17 pattern).
  const hasParseSignals = /parseInt\s*\(/.test(near)
                       || /\.slice\s*\(/.test(near)
                       || /\.substring\s*\(/.test(near)
                       || /Number\.parseInt/.test(near);
  // Signal 3: the match appears inside a template literal that assembles
  // rgba(...) from variables — e.g. `rgba(${r}, ${g}, ${b}, ...)`
  const assembledRgba = /rgba\s*\(\s*\$\{/.test(near) || /rgb\s*\(\s*\$\{/.test(near);

  if (bareRgbaCall && hasParseSignals) {
    return {
      tokenName: null,
      confidence: 'false-positive',
      rule: 'fp-bare-rgba-helper',
      rationale: 'Matched string is the literal "rgba(" inside a hex→rgb parser helper (parseInt/slice). Not a color value.',
    };
  }
  if (bareRgbaCall && assembledRgba) {
    return {
      tokenName: null,
      confidence: 'false-positive',
      rule: 'fp-assembled-rgba',
      rationale: 'Matched "rgba(" is the start of a dynamically-assembled rgba(${r},${g},${b},...) template literal — not a static color.',
    };
  }
  // Expanded: template literal with ${...} anywhere inside the rgba(...) call
  if (bareRgbaCall && /rgba\s*\([^)]*\$\{/.test(near)) {
    return {
      tokenName: null,
      confidence: 'false-positive',
      rule: 'fp-templated-rgba',
      rationale: 'Matched "rgba(" is a template literal rgba(...) with interpolated values — not a static color literal.',
    };
  }
  if (pathMatchesHelper && bareRgbaCall) {
    return {
      tokenName: null,
      confidence: 'false-positive',
      rule: 'fp-helper-file',
      rationale: `Bare "rgba(" inside helper file (${m.path}) — parser/converter, not a color literal.`,
    };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// 9. Rule-based classifier pipeline
// ──────────────────────────────────────────────────────────────────────────

function findTokenForElementAndRole(subsystem, elementKeywords, role) {
  const toks = tokensBySub.get(subsystem) || [];
  if (!toks.length) return null;

  // Candidates whose role matches
  const roleCandidates = toks.filter(t => tokenRole(t.name) === role);
  const pool = roleCandidates.length ? roleCandidates : toks;

  // Score by element keyword overlap with token name
  const scored = [];
  for (const t of pool) {
    const nameSegs = t.name.replace(/^--theme-/, '').split('-');
    let score = 0;
    for (const kw of elementKeywords) {
      if (!kw) continue;
      const kwLc = kw.toLowerCase();
      if (nameSegs.some(s => s.toLowerCase() === kwLc)) score += 3;
      else if (nameSegs.some(s => s.toLowerCase().includes(kwLc) || kwLc.includes(s.toLowerCase()))) score += 1;
    }
    if (score > 0 || pool.length === 1) scored.push({ tok: t, score });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  return {
    top: scored[0],
    ambiguous: scored.length > 1 && scored[0].score === scored[1].score,
    pool,
  };
}

function extractElementKeywords(m, parsedCtx) {
  const kws = new Set();
  // elementHint from audit
  if (m.elementHint) {
    for (const seg of m.elementHint.split(/[\s\-_/]+/)) if (seg) kws.add(seg);
  }
  // Dispatched selector in app.css
  if (m._dispatchSelector) {
    const first = m._dispatchSelector.split(/[,]/)[0].trim().replace(/^\./, '');
    for (const seg of first.split(/[-_]/)) if (seg) kws.add(seg);
  }
  // Keywords from the match line and adjacent context
  const text = (parsedCtx.matchLine || '') + ' ' + (parsedCtx.before || []).slice(-2).join(' ');
  const wordRe = /\b([a-zA-Z][a-zA-Z0-9]{2,})\b/g;
  let mm;
  while ((mm = wordRe.exec(text)) !== null) {
    const w = mm[1];
    if (/^(const|let|var|function|return|this|import|from|null|true|false|undefined|style|props|className|key|value|color|background|border|shadow|outline|fill|stroke|width|height|font|text|size|rem|px|center|flex|grid|div|span|top|bottom|left|right|none|auto|inherit|initial|transparent|rgba|rgb|hsl|var|url|linear|radial|gradient|ease|new|if|else|for|while|do|switch|case|break|continue|try|catch|throw|finally)$/.test(w)) continue;
    kws.add(w.toLowerCase());
  }
  return [...kws];
}

function tryRuleBased(m) {
  const ctx = parseContextLines(m.surroundingContext);
  const ext = (m.path.match(/\.([a-zA-Z0-9]+)$/) || [])[1] || '';
  const isCss = ext === 'css' || ext === 'scss';
  const isJs = /^(js|jsx|ts|tsx)$/.test(ext);

  // Rule 4: gradient in chrome surface — prefer gradient-capable tokens
  if (m.kind && m.kind.startsWith('gradient')) {
    // If file is app.css with dispatched subsystem, use that; else use subsystem as-is
    const sub = m.subsystem;
    const toks = tokensBySub.get(sub) || [];
    // Look for a -bg token marked as gradient capability 'any' or 'linear' in the catalog
    const gradCandidates = toks.filter(t => t.capability === 'linear' || t.capability === 'any');
    if (gradCandidates.length) {
      // Prefer tokens with matching element keywords
      const kws = extractElementKeywords(m, ctx);
      const scored = gradCandidates.map(t => {
        const nameSegs = t.name.replace(/^--theme-/, '').split('-');
        let s = 0;
        for (const k of kws) if (nameSegs.some(seg => seg.toLowerCase() === k.toLowerCase())) s += 2;
        return { t, s };
      }).sort((a, b) => b.s - a.s);
      const top = scored[0];
      if (top.s > 0) {
        return {
          tokenName: top.t.name,
          confidence: 'medium',
          rule: 'gradient-chrome-keyword',
          rationale: `Gradient in ${sub}; matched gradient-capable token via keyword overlap (score ${top.s}).`,
        };
      }
      // No keyword match → assign to subsystem primary bg gradient at medium
      const primary = toks.find(t => tokenRole(t.name) === 'bg'
                                    && (t.capability === 'any' || t.capability === 'linear'));
      if (primary) {
        return {
          tokenName: primary.name,
          confidence: 'medium',
          rule: 'gradient-chrome-primary',
          rationale: `Gradient in ${sub}; assigned to subsystem primary gradient-capable bg token.`,
        };
      }
    }
  }

  // Rule 3: CSS custom-property definition (--foo: #123;)
  if (isCss && /^\s*--[a-zA-Z0-9-]+\s*:/.test(ctx.matchLine)) {
    const varName = (ctx.matchLine.match(/^\s*(--[a-zA-Z0-9-]+)/) || [])[1];
    if (varName) {
      // Look up catalog directly
      if (TOKENS_BY_NAME[varName] && TOKENS_BY_NAME[varName].kind === 'color') {
        return {
          tokenName: varName,
          confidence: 'high',
          rule: 'css-var-def-direct',
          rationale: `CSS variable definition ${varName} matches catalog token exactly.`,
        };
      }
      // Heuristic: strip `--theme-` prefix and try to find equivalent
      // Otherwise no direct catalog equivalent
    }
  }

  // Rule 1: CSS property direct match
  if (isCss) {
    const matchLineRole = findRole(ctx.matchLine, CSS_PROP_PATTERNS);
    // also check previous line for multi-line declarations
    let role = matchLineRole;
    if (!role && ctx.before.length) {
      const prev = ctx.before[ctx.before.length - 1];
      role = findRole(prev, CSS_PROP_PATTERNS);
    }
    if (role) {
      const kws = extractElementKeywords(m, ctx);
      const res = findTokenForElementAndRole(m.subsystem, kws, role);
      if (res && res.top.score >= 3) {
        return {
          tokenName: res.top.tok.name,
          confidence: res.ambiguous ? 'medium' : 'high',
          rule: 'css-property-direct',
          rationale: `CSS property ${role} in ${m.subsystem}; strongest keyword overlap with token (score ${res.top.score}).`,
        };
      }
      if (res && res.top.score >= 1) {
        return {
          tokenName: res.top.tok.name,
          confidence: 'medium',
          rule: 'css-property-partial',
          rationale: `CSS property ${role} in ${m.subsystem}; weaker keyword overlap (score ${res.top.score}).`,
        };
      }
      // Fallback: primary role token for subsystem
      const toks = tokensBySub.get(m.subsystem) || [];
      const primary = toks.find(t => tokenRole(t.name) === role);
      if (primary) {
        return {
          tokenName: primary.name,
          confidence: 'medium',
          rule: 'css-property-subsystem-primary',
          rationale: `CSS property ${role} in ${m.subsystem}; no element match, fell back to subsystem primary ${role}.`,
        };
      }
    }
  }

  // Rule 2: JSX inline style / canvas API / SVG attrs / destructure defaults
  if (isJs) {
    // check match line and ±2 lines for any JS-styling role signal
    const probeLines = [ctx.matchLine, ...(ctx.before.slice(-2)), ...(ctx.after.slice(0, 1))];
    const probeAll = probeLines.join(' | ');
    let role = null;
    let ruleHint = null;
    // Canvas / SVG patterns take priority (very deterministic)
    for (const p of CANVAS_SVG_PATTERNS) if (p.re.test(probeAll)) { role = p.role; ruleHint = 'canvas-svg'; break; }
    if (!role) for (const p of JSX_KEY_PATTERNS) if (p.re.test(probeAll)) { role = p.role; ruleHint = 'jsx-inline'; break; }
    if (!role) for (const p of DESTRUCTURE_DEFAULT_PATTERNS) if (p.re.test(probeAll)) { role = p.role; ruleHint = 'jsx-destructure'; break; }
    if (!role) {
      // Const/var color definition — role is 'constant' but we can still match by name
      for (const p of CONST_DEF_PATTERNS) if (p.re.test(probeAll)) { role = 'constant'; ruleHint = 'const-def'; break; }
    }
    if (!role) {
      // Hint-based fallback: audit already extracted an elementHint like
      // 'canvas-fill', 'canvas-stroke', 'border', 'bg', 'fg', 'gradient-stop'.
      const hintRole = roleFromHint(m.elementHint);
      if (hintRole) { role = hintRole; ruleHint = 'hint-role'; }
    }
    if (role) {
      const kws = extractElementKeywords(m, ctx);
      // Add path-derived element clues
      const fileBase = path.basename(m.path).replace(/\.(jsx?|tsx?)$/, '').toLowerCase();
      for (const seg of fileBase.split(/(?=[A-Z])|[-_]/)) if (seg && seg.length > 2) kws.push(seg.toLowerCase());
      // Add var-name segments for const-def rule (KNOB_COLOR → knob, color)
      if (ruleHint === 'const-def') {
        for (const p of CONST_DEF_PATTERNS) {
          const mm = probeAll.match(p.re);
          if (mm && mm[1]) {
            for (const seg of mm[1].split(/[_-]|(?=[A-Z])/)) {
              const s = seg.toLowerCase();
              if (s && s.length > 2 && s !== 'color' && s !== 'colors') kws.push(s);
            }
            break;
          }
        }
      }
      // For 'constant' pseudo-role, don't filter by token role — just score by keywords
      const effectiveRole = role === 'constant' ? null : role;
      const res = effectiveRole
        ? findTokenForElementAndRole(m.subsystem, kws, effectiveRole)
        : findTokenForElementAndRole(m.subsystem, kws, 'bg'); // try bg first, but pool falls through to all tokens if no bg match
      if (res && res.top.score >= 3) {
        return {
          tokenName: res.top.tok.name,
          confidence: res.ambiguous ? 'medium' : 'high',
          rule: `${ruleHint}-direct`,
          rationale: `${ruleHint} ${role} in ${m.subsystem}; strongest keyword overlap (score ${res.top.score}).`,
        };
      }
      if (res && res.top.score >= 1) {
        return {
          tokenName: res.top.tok.name,
          confidence: 'medium',
          rule: `${ruleHint}-partial`,
          rationale: `${ruleHint} ${role} in ${m.subsystem}; weaker keyword overlap (score ${res.top.score}).`,
        };
      }
      // Fallback to subsystem primary for this role (only meaningful for real roles)
      if (effectiveRole) {
        const toks = tokensBySub.get(m.subsystem) || [];
        const primary = toks.find(t => tokenRole(t.name) === effectiveRole);
        if (primary) {
          return {
            tokenName: primary.name,
            confidence: 'medium',
            rule: `${ruleHint}-subsystem-primary`,
            rationale: `${ruleHint} ${role} in ${m.subsystem}; no element match, fell back to subsystem primary ${effectiveRole}.`,
          };
        }
      }
    }
  }

  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// 10. Judgment step (keyword scoring, subsystem-gated, deterministic)
// ──────────────────────────────────────────────────────────────────────────

function tryJudgment(m) {
  const ctx = parseContextLines(m.surroundingContext);
  const toks = tokensBySub.get(m.subsystem) || [];
  if (!toks.length) return null;

  const kws = extractElementKeywords(m, ctx);
  if (!kws.length) return null;

  // Score every subsystem token by keyword overlap
  const scored = toks.map(t => {
    const nameSegs = t.name.replace(/^--theme-/, '').split('-');
    let score = 0;
    for (const kw of kws) {
      if (!kw || kw.length < 2) continue;
      const kwLc = kw.toLowerCase();
      if (nameSegs.some(s => s.toLowerCase() === kwLc)) score += 2;
      else if (nameSegs.some(s => s.toLowerCase().includes(kwLc) && kwLc.length > 3)) score += 1;
    }
    return { tok: t, score };
  }).sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score < 2) return null; // threshold

  return {
    tokenName: top.tok.name,
    confidence: 'low',
    rule: 'keyword-match',
    rationale: `Matched via keyword scoring (score ${top.score}); element unclear — reviewer should confirm.`,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 11. Main classify pipeline
// ──────────────────────────────────────────────────────────────────────────

function classify(m) {
  const fp = tryFalsePositive(m);
  if (fp) return fp;

  // Subsystem must have catalog tokens; if not, no-fit immediately
  if (!tokensBySub.has(m.subsystem) || tokensBySub.get(m.subsystem).length === 0) {
    return {
      tokenName: null,
      confidence: 'no-fit',
      rule: null,
      rationale: `No color tokens for subsystem '${m.subsystem}' (catalog gap).`,
    };
  }

  const rb = tryRuleBased(m);
  if (rb) return rb;

  const jj = tryJudgment(m);
  if (jj) return jj;

  return {
    tokenName: null,
    confidence: 'no-fit',
    rule: null,
    rationale: 'No rule or judgment score reached threshold for this subsystem.',
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 12. Run classifier on all color matches
// ──────────────────────────────────────────────────────────────────────────

const enriched = [];
const tierCounts = { high: 0, medium: 0, low: 0, 'no-fit': 0, 'false-positive': 0 };
const ruleCounts = {};
const assignmentCounts = new Map(); // tokenName → count

for (const m of colorMatches) {
  const result = classify(m);
  tierCounts[result.confidence]++;
  if (result.rule) ruleCounts[result.rule] = (ruleCounts[result.rule] || 0) + 1;
  if (result.tokenName) assignmentCounts.set(result.tokenName, (assignmentCounts.get(result.tokenName) || 0) + 1);

  enriched.push({
    path:               m.path,
    line:               m.line,
    column:             m.column,
    matchedText:        m.matchedText,
    kind:               m.kind,
    subsystem:          m.subsystem,
    originalSubsystem:  m._dispatchedFrom ? 'chrome-layout' : m.subsystem,
    dispatch:           m._dispatchedFrom ? 'dispatched' : (m._dispatch || (m.subsystem === 'chrome-layout' ? 'unmatched' : 'native')),
    dispatchSelector:   m._dispatchSelector || null,
    elementHint:        m.elementHint || null,
    surroundingContext: m.surroundingContext,
    ambiguous:          !!m.ambiguous,
    ambiguityReason:    m.ambiguityReason || null,
    proposedTokenName:  result.tokenName,
    confidence:         result.confidence,
    assignmentRule:     result.rule,
    rationale:          result.rationale,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 12b. Label-color re-subsystem pass
//
// The audit attributed LABEL_COLORS array literals in JS files to their
// enclosing file's subsystem (timeline, sample-selector). The catalog hoists
// these to the dedicated 'labels' subsystem. The CSS-selector dispatcher
// doesn't fire here (no CSS selector context), so a post-classification pass
// catches them by value: file path ∩ exact catalog label hex value.
//
// Detection condition (both must hold):
//   1. m.path matches /SampleRow\.jsx|labels\.js|TrackHeader\.jsx/i
//   2. m.matchedText normalised equals one of the 8 catalog label hex values
//
// Assignment: value-direct → confidence HIGH, rule 'label-value-direct'.
// Adds reSubsystemed: true on each affected entry for auditability.
// ──────────────────────────────────────────────────────────────────────────

const LABEL_FILE_RE = /SampleRow\.jsx|labels\.js|TrackHeader\.jsx/i;
let reSubsystemedCount = 0;

for (const m of enriched) {
  if (!LABEL_FILE_RE.test(m.path)) continue;
  const normVal = m.matchedText.toLowerCase().replace(/\s+/g, '');
  const tokenName = explicitValueIndex.get(normVal);
  if (!tokenName) continue;
  const tok = TOKENS_BY_NAME[tokenName];
  if (!tok || tok.subsystem !== 'labels') continue;

  const prevConfidence = m.confidence;

  m.subsystem        = 'labels';   // originalSubsystem already captured correctly
  m.proposedTokenName = tokenName;
  m.confidence       = 'high';
  m.assignmentRule   = 'label-value-direct';
  m.rationale        = `Hex value ${m.matchedText} equals catalog label token value exactly; re-subsystemed from ${m.originalSubsystem}.`;
  m.reSubsystemed    = true;
  reSubsystemedCount++;

  // Fix tier counts: undo old tier, add new
  tierCounts[prevConfidence]--;
  tierCounts.high++;
  // Update assignment frequency map
  assignmentCounts.set(tokenName, (assignmentCounts.get(tokenName) || 0) + 1);
}

console.log(`  Re-subsystemed (label-color pass): ${reSubsystemedCount} matches → 'labels' HIGH`);

// ──────────────────────────────────────────────────────────────────────────
// 13. Write enriched JSON
// ──────────────────────────────────────────────────────────────────────────

const ENRICH_JSON = path.resolve(__dirname, 'theming-audit-enriched.json');
fs.writeFileSync(ENRICH_JSON, JSON.stringify({
  generatedAt: new Date().toISOString(),
  scope: 'color-only',
  totalColorMatches: enriched.length,
  excludedDimensionMatches: dimensionMatches.length,
  confidenceCounts: tierCounts,
  ruleCounts,
  dispatchStats,
  matches: enriched,
}, null, 2), 'utf8');

// ──────────────────────────────────────────────────────────────────────────
// 14. Write review markdown
// ──────────────────────────────────────────────────────────────────────────

function pct(n, total) { return ((100 * n) / total).toFixed(1) + '%'; }

function mdEscape(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const tot = enriched.length;
const highMediumCount = tierCounts.high + tierCounts.medium;

function writeReviewMd() {
  let md = '';
  md += `# Theming Audit Enrichment — Review Document\n\n`;
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `## Summary\n\n`;
  md += `- **Color matches enriched:** ${tot}\n`;
  md += `- **Dimension matches (${dimensionMatches.length}):** deferred to spacing-scale design track — see [theming-dimension-analysis.md](theming-dimension-analysis.md)\n\n`;
  md += `### Confidence tier breakdown\n\n`;
  md += `| Tier | Count | % |\n|---|---:|---:|\n`;
  md += `| HIGH | ${tierCounts.high} | ${pct(tierCounts.high, tot)} |\n`;
  md += `| MEDIUM | ${tierCounts.medium} | ${pct(tierCounts.medium, tot)} |\n`;
  md += `| LOW (must review) | ${tierCounts.low} | ${pct(tierCounts.low, tot)} |\n`;
  md += `| NO-FIT (catalog gap) | ${tierCounts['no-fit']} | ${pct(tierCounts['no-fit'], tot)} |\n`;
  md += `| FALSE-POSITIVE | ${tierCounts['false-positive']} | ${pct(tierCounts['false-positive'], tot)} |\n`;
  md += `| **Rule-based (HIGH + MEDIUM)** | **${highMediumCount}** | **${pct(highMediumCount, tot)}** |\n\n`;

  md += `### Dispatch distribution (app.css chrome-layout matches)\n\n`;
  md += `| Target subsystem | Count |\n|---|---:|\n`;
  const dispRows = Object.entries(dispatchStats).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of dispRows) md += `| ${k} | ${v} |\n`;
  md += `\n`;

  md += `### Rule usage\n\n`;
  md += `| Rule | Count |\n|---|---:|\n`;
  for (const [k, v] of Object.entries(ruleCounts).sort((a, b) => b[1] - a[1])) md += `| ${k} | ${v} |\n`;
  md += `\n`;

  md += `### Top 20 most-frequent assignments\n\n`;
  md += `| Token | Count |\n|---|---:|\n`;
  const topAssigns = [...assignmentCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [k, v] of topAssigns) md += `| \`${k}\` | ${v} |\n`;
  md += `\n`;

  // HIGH — deduped by token
  md += `## High-confidence assignments (summary)\n\n`;
  const highByToken = new Map();
  for (const m of enriched) {
    if (m.confidence !== 'high') continue;
    const key = m.proposedTokenName;
    if (!highByToken.has(key)) highByToken.set(key, { count: 0, rule: m.assignmentRule, samples: [] });
    const e = highByToken.get(key);
    e.count++;
    if (e.samples.length < 3) e.samples.push(`${m.path}:${m.line}`);
  }
  md += `| Token | Count | Rule | Sample locations |\n|---|---:|---|---|\n`;
  for (const [tok, info] of [...highByToken.entries()].sort((a, b) => b[1].count - a[1].count)) {
    md += `| \`${tok}\` | ${info.count} | ${info.rule} | ${info.samples.join(', ')} |\n`;
  }
  md += `\n`;

  // MEDIUM — individual rows
  md += `## Medium-confidence assignments (review recommended)\n\n`;
  md += `| File:Line | Matched | → Proposed token | Rule | Context |\n|---|---|---|---|---|\n`;
  for (const m of enriched.filter(x => x.confidence === 'medium')) {
    md += `| ${m.path}:${m.line} | \`${mdEscape(m.matchedText)}\` | \`${m.proposedTokenName}\` | ${m.assignmentRule} | ${mdEscape(truncate(m.elementHint || '(no hint)', 60))} |\n`;
  }
  md += `\n`;

  // LOW — full context
  md += `## Low-confidence assignments (must review)\n\n`;
  for (const m of enriched.filter(x => x.confidence === 'low')) {
    md += `### ${m.path}:${m.line}\n`;
    md += `- **matched:** \`${m.matchedText}\`  (kind=${m.kind})\n`;
    md += `- **subsystem:** ${m.subsystem}\n`;
    md += `- **proposed:** \`${m.proposedTokenName}\`\n`;
    md += `- **rationale:** ${m.rationale}\n`;
    md += `- **element hint:** ${m.elementHint || '(none)'}\n`;
    md += `- **context:**\n\n\`\`\`\n${(m.surroundingContext || '').slice(0, 600)}\n\`\`\`\n\n`;
  }

  // FALSE-POSITIVE — sample
  md += `## False-positive matches (audit errors, not catalog gaps)\n\n`;
  md += `| File:Line | Matched | Rule | Rationale |\n|---|---|---|---|\n`;
  for (const m of enriched.filter(x => x.confidence === 'false-positive')) {
    md += `| ${m.path}:${m.line} | \`${mdEscape(m.matchedText)}\` | ${m.assignmentRule} | ${mdEscape(truncate(m.rationale || '', 160))} |\n`;
  }
  md += `\n`;

  fs.writeFileSync(path.resolve(__dirname, 'theming-enrichment-review.md'), md, 'utf8');
}
writeReviewMd();

// ──────────────────────────────────────────────────────────────────────────
// 15. Write catalog-gap report (no-fit matches only)
// ──────────────────────────────────────────────────────────────────────────

function writeGapsMd() {
  const noFits = enriched.filter(m => m.confidence === 'no-fit');
  // Group by subsystem + elementHint
  const groups = new Map();
  for (const m of noFits) {
    const key = `${m.subsystem}::${m.elementHint || '(no hint)'}`;
    if (!groups.has(key)) groups.set(key, { subsystem: m.subsystem, element: m.elementHint || '(no hint)', items: [] });
    groups.get(key).items.push(m);
  }

  // Build per-subsystem → group list
  const bySub = new Map();
  for (const g of groups.values()) {
    if (!bySub.has(g.subsystem)) bySub.set(g.subsystem, []);
    bySub.get(g.subsystem).push(g);
  }

  let md = '';
  md += `# Catalog Gap Report\n\n`;
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `## Summary\n\n`;
  md += `- NO-FIT matches: ${noFits.length}\n`;
  md += `- Unique (subsystem, element) gap groups: ${groups.size}\n\n`;
  md += `Per rule: false-positive matches are NOT listed here — they are audit errors, not catalog gaps.\n\n`;

  md += `## Gaps by subsystem\n\n`;
  const subsSorted = [...bySub.entries()].sort((a, b) => {
    const ca = a[1].reduce((x, g) => x + g.items.length, 0);
    const cb = b[1].reduce((x, g) => x + g.items.length, 0);
    return cb - ca;
  });

  for (const [sub, groupsForSub] of subsSorted) {
    const total = groupsForSub.reduce((x, g) => x + g.items.length, 0);
    md += `### ${sub} (${total} matches across ${groupsForSub.length} groups)\n\n`;
    groupsForSub.sort((a, b) => b.items.length - a.items.length);
    for (const g of groupsForSub) {
      md += `- **Element "${g.element}"** — ${g.items.length} occurrence(s)\n`;
      const samples = g.items.slice(0, 3).map(i => `${i.path}:${i.line}`);
      md += `  - Samples: ${samples.join(', ')}\n`;
      // Propose a token name
      const elementSlug = String(g.element || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
      // Derive slug for token name
      const tokenSubSlug = sub.replace(/-/g, '');
      md += `  - Proposed addition: \`--theme-${sub.replace(/\./g, '-')}-${elementSlug}\` *(suggestion only — requires approval)*\n`;
    }
    md += `\n`;
  }

  fs.writeFileSync(path.resolve(__dirname, 'theming-catalog-gaps.md'), md, 'utf8');
}
writeGapsMd();

// ──────────────────────────────────────────────────────────────────────────
// 16. Write dimension-analysis.md (separate artifact, pure data)
// ──────────────────────────────────────────────────────────────────────────

function writeDimensionAnalysis() {
  const total = dimensionMatches.length;
  const freq = new Map(); // value → { count, fileSet }
  for (const m of dimensionMatches) {
    const v = m.matchedText;
    if (!freq.has(v)) freq.set(v, { count: 0, files: new Map() });
    const e = freq.get(v);
    e.count++;
    e.files.set(m.path, (e.files.get(m.path) || 0) + 1);
  }
  const sorted = [...freq.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 30);

  // By element hint
  const hints = new Map();
  for (const m of dimensionMatches) {
    const h = m.elementHint || '(none)';
    hints.set(h, (hints.get(h) || 0) + 1);
  }
  const hintsSorted = [...hints.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  let md = '';
  md += `# Dimension Analysis\n\n`;
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `## Purpose\n\n`;
  md += `The color-only enrichment excludes chrome-dimension matches (spacing, padding, gap, border-radius, width/height, etc.). A spacing/radius scale design is queued as a separate track. This file is pure data — no assignments, no per-match enrichment.\n\n`;
  md += `## Total dimension matches\n\n`;
  md += `${total}\n\n`;
  md += `## Top 30 most-frequent dimension values\n\n`;
  md += `| Value | Count | Files (top 5) |\n|---|---:|---|\n`;
  for (const [v, e] of sorted) {
    const top5 = [...e.files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([p, c]) => `${p}:${c}`).join(', ');
    md += `| \`${v.replace(/\|/g, '\\|')}\` | ${e.count} | ${top5} |\n`;
  }
  md += `\n## Top 20 element hints\n\n`;
  md += `| Hint | Count |\n|---|---:|\n`;
  for (const [h, c] of hintsSorted) md += `| ${h} | ${c} |\n`;
  md += `\n## File distribution (top 10)\n\n`;
  const fileCounts = new Map();
  for (const m of dimensionMatches) fileCounts.set(m.path, (fileCounts.get(m.path) || 0) + 1);
  md += `| File | Count |\n|---|---:|\n`;
  for (const [p, c] of [...fileCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    md += `| ${p} | ${c} |\n`;
  }
  md += `\n## Next steps\n\n`;
  md += `The spacing/radius token scale belongs to a separate design track. Options:\n\n`;
  md += `1. Define a canonical dimension scale (e.g. \`--theme-space-1\` … \`--theme-space-12\`, \`--theme-radius-sm/md/lg\`) and replace raw px values across the codebase.\n`;
  md += `2. Define per-subsystem dimension tokens for the few cases where a subsystem needs divergent spacing.\n`;
  md += `3. Accept raw pixel values in non-themable chrome (app shell) and only tokenise where Advanced mode needs to override.\n\n`;
  md += `This document is the data input for that design decision — no action is taken here.\n`;

  fs.writeFileSync(path.resolve(__dirname, 'theming-dimension-analysis.md'), md, 'utf8');
}
writeDimensionAnalysis();

// ──────────────────────────────────────────────────────────────────────────
// 17. Stdout summary
// ──────────────────────────────────────────────────────────────────────────

console.log('');
console.log('═══════════════════════════════════════════════════');
console.log('  ENRICHMENT RESULTS');
console.log('═══════════════════════════════════════════════════');
console.log(`  Total color matches: ${tot}`);
console.log('');
console.log('  Confidence tier breakdown:');
for (const [k, v] of Object.entries(tierCounts)) {
  console.log(`    ${k.padEnd(16)} ${v.toString().padStart(5)}  (${pct(v, tot)})`);
}
const covered = tierCounts.high + tierCounts.medium;
console.log('');
console.log(`  Label-color re-subsystemed: ${reSubsystemedCount}`);
console.log(`  Rule-based coverage (HIGH + MEDIUM): ${covered} (${pct(covered, tot)})`);
if ((100 * covered / tot) < 80) {
  console.log('  ⚠︎  COVERAGE BELOW 80% — classifier design may have a bug. Pause and investigate.');
} else {
  console.log('  ✓  Coverage ≥ 80%.');
}
console.log('');
console.log('  Top 20 most-frequent assignments:');
for (const [k, v] of [...assignmentCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`    ${v.toString().padStart(4)}  ${k}`);
}
console.log('');
console.log('  Dispatch distribution (app.css chrome-layout):');
for (const [k, v] of Object.entries(dispatchStats).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${v.toString().padStart(4)}  ${k}`);
}
console.log('');
console.log('  Rule counts:');
for (const [k, v] of Object.entries(ruleCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${v.toString().padStart(4)}  ${k}`);
}
console.log('');
console.log('  Artifacts written:');
console.log('    scripts/theming-audit-enriched.json');
console.log('    scripts/theming-enrichment-review.md');
console.log('    scripts/theming-catalog-gaps.md');
console.log('    scripts/theming-dimension-analysis.md');
console.log('');
