#!/usr/bin/env node
'use strict';

// theming-audit-enrich-v2.js — Wave 0 / Phase 0 rebuild (Step 3)
//
// Replaces the v1 keyword-overlap classifier with a deterministic 4-gate
// cascade: value equality → capability → subsystem → priority tie-break.
// See xleth-theming-spec.md §3.5.1 and the plan file for rationale.
//
// Inputs  : scripts/theming-audit-enriched.json      (matches + FP priors)
//           ui/src/theming/tokens/{catalog,base,derivation}.ts (token truth)
// Outputs : scripts/theming-audit-enriched-v2.json   (v1 schema + 2 fields)
//           stdout integrity + per-confidence summary + top zero-candidate values
//
// Zero network / LLM calls.
//
// ── CLASSIFIER CORRECTNESS HISTORY (22/30 → 27/30 = 90 %) ─────────────────
//
// Five successive rule additions brought MEDIUM correctness from 73 % to 90 %.
// DO NOT remove any of these rules — each fixes a specific failure mode.
//
// Rule 2a — Part 1 (alias-prune before hint scoring)
//   What it does : drops `derived-var` candidates whose referent is already in
//                  the survivor pool AND whose semantic tail is absent from the
//                  hint phrase.
//   Failure mode : a token like `--theme-sampler-key-bg` is a pure `derived-var`
//                  alias of `--theme-bg-surface`. Without this rule, the alias
//                  won the hint match for any `.sampler-*` selector (because
//                  "sampler" appeared in the selector), pushing the correct
//                  base token out. Raised 22 → 25.
//
// Rule 2a — Part 2 (same-subsystem explicit drop when universal base covers)
//   What it does : when ≥ 2 same-subsystem candidates share the value, drops
//                  same-subsystem explicit/derived-formula tokens whose semantic
//                  tail has no grounding in the hint, leaving the universal base
//                  token as the sole survivor.
//   Failure mode : e.g. `--theme-sampler-loaded-bg` and `--theme-bg-secondary`
//                  both resolve to the same grey; the subsystem token won the
//                  hint race even though the context said nothing about "loaded".
//                  Raised subset of 25 → 26 entries.
//   Guard        : only fires when sameSubCount ≥ 2, preventing it from
//                  incorrectly dropping a lone correct same-subsystem token
//                  (e.g. `--theme-preview-loaded-bg` was previously lost).
//
// hintScore subsystem-word strip
//   What it does : the `hintScore` helper splits the token's tail on `-` and
//                  filters out any word that also appears in the match's
//                  subsystem name before measuring overlap length. Words like
//                  "sampler", "timeline", "nodeeditor" are already captured by
//                  Gate 3 and must not inflate the hint score a second time.
//   Failure mode : `--theme-sampler-lfo-color-volume` scored 12 ("sampler"=7 +
//                  "color"=5) against a focus-border context, beating
//                  `--theme-border-focus` (11 chars). The subsystem word
//                  "sampler" was double-counted. Raised 25 → 26.
//
// v2-gate-tiebreak-subsystem-unanchored LOW demotion
//   What it does : after tie-break, if the winner's semantic tail has no word
//                  overlap with the hint phrase AND ≥ 2 other-subsystem tokens
//                  share the same value, the result is demoted from MEDIUM to
//                  LOW with rule `v2-gate-tiebreak-subsystem-unanchored`.
//   Failure mode : `NodeEditor.jsx:174` muted-connection `#555566` → the only
//                  same-subsystem token holding that value was
//                  `--theme-nodeeditor-port-default`, whose tail "port" never
//                  appeared in the context ("muted", "connection"). The entry
//                  was incorrectly MEDIUM and polluted the correctness sample.
//                  Removing it from the MEDIUM pool raised 26 → 27.
//
// ────────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

// ──────────────────────────────────────────────────────────────────────────
// 1. Esbuild-bundle catalog + derivation + base so we can call resolveTheme.
// ──────────────────────────────────────────────────────────────────────────

const uiRoot = path.resolve(__dirname, '../ui');
const tmpDir  = path.resolve(uiRoot, 'node_modules/.theming-v2-cache');
fs.mkdirSync(tmpDir, { recursive: true });

const entrySrc = `
const catalog = require('${path.resolve(uiRoot, 'src/theming/tokens/catalog.ts').replace(/\\/g, '/')}');
const base = require('${path.resolve(uiRoot, 'src/theming/tokens/base.ts').replace(/\\/g, '/')}');
const derivation = require('${path.resolve(uiRoot, 'src/theming/tokens/derivation.ts').replace(/\\/g, '/')}');
module.exports = {
  TOKENS: catalog.TOKENS,
  TOKENS_BY_NAME: catalog.TOKENS_BY_NAME,
  SUBSYSTEMS: catalog.SUBSYSTEMS,
  BASE_DEFAULTS: base.BASE_DEFAULTS,
  BASE_TOKEN_NAMES: base.BASE_TOKEN_NAMES,
  deriveTheme: derivation.deriveTheme,
};
`;
const entryFile = path.join(tmpDir, 'entry.cjs.ts');
fs.writeFileSync(entryFile, entrySrc);
const outFile = path.join(tmpDir, 'bundle.cjs');
try {
  execSync(
    `node -e "require('esbuild').buildSync({entryPoints:['${entryFile.replace(/\\/g, '/')}'],bundle:true,format:'cjs',outfile:'${outFile.replace(/\\/g, '/')}',platform:'node'})"`,
    { cwd: uiRoot, stdio: 'pipe' }
  );
} catch (e) {
  console.error('ERROR: failed to bundle theming runtime:', e.message);
  if (e.stderr) console.error(e.stderr.toString());
  process.exit(1);
}
const { TOKENS, TOKENS_BY_NAME, SUBSYSTEMS, BASE_DEFAULTS, deriveTheme } = require(outFile);

// ──────────────────────────────────────────────────────────────────────────
// 2. Resolve every token to its leaf value (flatten derived-var refs).
// ──────────────────────────────────────────────────────────────────────────

const derivedFormulaValues = deriveTheme(BASE_DEFAULTS, []);

function leafValue(name, seen = new Set()) {
  if (seen.has(name)) return null; // cycle guard
  seen.add(name);
  const t = TOKENS_BY_NAME[name];
  if (!t) return null;
  switch (t.derivation.type) {
    case 'base':            return BASE_DEFAULTS[name] || null;
    case 'explicit':        return t.derivation.value;
    case 'derived-formula': return derivedFormulaValues[name] || null;
    case 'derived-var':     return leafValue(t.derivation.ref, seen);
  }
  return null;
}

const resolveChain = {};
for (const t of TOKENS) resolveChain[t.name] = leafValue(t.name);

// ──────────────────────────────────────────────────────────────────────────
// 3. Value normalizer + kind inferrer
// ──────────────────────────────────────────────────────────────────────────

// Minimal W3C named-color table. `black` is the only load-bearing name seen
// in the audit, but the broader table is included defensively per C3.b plan.
const NAMED_COLORS = {
  black:       '#000000',
  white:       '#ffffff',
  transparent: 'rgba(0, 0, 0, 0)',
  red:         '#ff0000',
  green:       '#008000',
  blue:        '#0000ff',
  yellow:      '#ffff00',
  cyan:        '#00ffff',
  magenta:     '#ff00ff',
  gray:        '#808080',
  grey:        '#808080',
  silver:      '#c0c0c0',
  maroon:      '#800000',
  olive:       '#808000',
  lime:        '#00ff00',
  aqua:        '#00ffff',
  teal:        '#008080',
  navy:        '#000080',
  fuchsia:     '#ff00ff',
  purple:      '#800080',
  orange:      '#ffa500',
};

function normalizeHex(hex) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex);
  if (!m) return hex.toLowerCase();
  const s = m[1].toLowerCase();
  if (s.length === 3) return '#' + s.split('').map(c => c + c).join('');
  if (s.length === 4) {
    // #RGBA → #RRGGBBAA, then drop alpha=ff or fold to rgba
    const expanded = s.split('').map(c => c + c).join('');
    return '#' + expanded;
  }
  return '#' + s;
}

function normalizeRgbaInner(inner) {
  // "0,0,0,0.6" or " 51 , 206 , 214 , 0.35 " → "R, G, B, A" canonical
  const parts = inner.split(',').map(p => p.trim());
  return parts.join(', ');
}

function normalizeValue(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();

  // Named color?
  const lower = s.toLowerCase();
  if (NAMED_COLORS[lower]) return NAMED_COLORS[lower];

  // Hex
  if (/^#[0-9a-f]+$/i.test(s)) return normalizeHex(s);

  // rgba / rgb / hsl / hsla — lowercase function name, canonical comma spacing
  const fnMatch = /^(rgba?|hsla?)\s*\(\s*(.*?)\s*\)$/i.exec(s);
  if (fnMatch) {
    const fn = fnMatch[1].toLowerCase();
    const inner = normalizeRgbaInner(fnMatch[2]);
    return `${fn}(${inner})`;
  }

  // Gradient — normalize function name + each stop's color
  const gradMatch = /^(linear|radial|conic)-gradient\s*\(\s*(.*)\s*\)$/i.exec(s);
  if (gradMatch) {
    const fn = gradMatch[1].toLowerCase() + '-gradient';
    const inner = gradMatch[2];
    // Split inner on TOP-LEVEL commas (bracket-depth counter)
    const stops = splitTopLevelCommas(inner).map(seg => {
      // Each seg may be "direction" or "color position" or "color"
      // Normalize embedded colors using a regex replace.
      return seg.trim()
        .replace(/#[0-9a-f]{3,8}/gi, (m) => normalizeHex(m))
        .replace(/(rgba?|hsla?)\s*\(\s*([^)]+?)\s*\)/gi,
          (_, f, inn) => `${f.toLowerCase()}(${normalizeRgbaInner(inn)})`);
    });
    return `${fn}(${stops.join(', ')})`;
  }

  // Shadow compound: "0 12px 40px rgba(0, 0, 0, 0.6)" or multi-shadow
  // Multi-shadow: split on TOP-LEVEL commas, normalize each compound's embedded
  // colors, re-join with ", ".
  if (/\d/.test(s) && /(rgba?|hsla?|#[0-9a-f])/i.test(s)) {
    const compounds = splitTopLevelCommas(s);
    if (compounds.length > 0) {
      const normalized = compounds.map(c => normalizeCompound(c)).join(', ');
      return normalized;
    }
  }

  return s;
}

function normalizeCompound(s) {
  // Normalize embedded colors + collapse whitespace.
  return s.trim()
    .replace(/\s+/g, ' ')
    .replace(/#[0-9a-f]{3,8}/gi, (m) => normalizeHex(m))
    .replace(/(rgba?|hsla?)\s*\(\s*([^)]+?)\s*\)/gi,
      (_, f, inn) => `${f.toLowerCase()}(${normalizeRgbaInner(inn)})`);
}

// Bracket-depth-aware comma splitter. Required for F1 multi-shadow handling
// and gradient stop splitting — naive regex splits inside rgba() parens.
function splitTopLevelCommas(s) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map(p => p.trim()).filter(p => p.length > 0);
}

// Extract every color literal (hex, rgba, hsla, named) from a compound value.
function extractColorsFromCompound(s) {
  const colors = [];
  const reHex  = /#[0-9a-f]{3,8}\b/gi;
  const reFn   = /(?:rgba?|hsla?)\s*\([^)]+\)/gi;
  let m;
  while ((m = reHex.exec(s))) colors.push(normalizeHex(m[0]));
  while ((m = reFn.exec(s))) {
    const inner = m[0].replace(/^(rgba?|hsla?)\s*\(\s*|\s*\)$/gi, '');
    const fn = /^(rgba?|hsla?)/i.exec(m[0])[1].toLowerCase();
    colors.push(`${fn}(${normalizeRgbaInner(inner)})`);
  }
  return colors;
}

function inferValueKind(normalized) {
  if (/^#[0-9a-f]{6}$/.test(normalized)) return 'color';
  if (/^#[0-9a-f]{8}$/.test(normalized)) return 'rgba'; // 8-digit hex = rgba
  if (/^rgba?\(/.test(normalized)) return 'rgba';
  if (/^hsla?\(/.test(normalized)) return 'rgba';
  if (/^(linear|radial|conic)-gradient\(/.test(normalized)) return 'gradient';
  // Shadow heuristic: has a px/em dimension AND an embedded color
  if (/\b\d+(?:\.\d+)?(px|em|rem|%)/.test(normalized)
      && /(rgba?\(|hsla?\(|#[0-9a-f]{3,8})/i.test(normalized)) return 'shadow';
  return 'unknown';
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Build indexes
// ──────────────────────────────────────────────────────────────────────────

const valueIndex = new Map();      // normalizedValue → TokenDef[]
const shadowColorIndex = new Map();// embedded normalized color → shadow TokenDef[]
const gradientColorIndex = new Map();// embedded gradient-stop color → gradient TokenDef[]
const valueKindIndex = {};         // tokenName → valueKind
const tokensBySubsystem = new Map();

for (const t of TOKENS) {
  if (t.kind !== 'color') continue; // only color-valued tokens matter for audit
  const leaf = resolveChain[t.name];
  if (!leaf) continue;
  const norm = normalizeValue(leaf);
  const kind = inferValueKind(norm);
  valueKindIndex[t.name] = kind;

  if (!valueIndex.has(norm)) valueIndex.set(norm, []);
  valueIndex.get(norm).push(t);

  // For shadow tokens, also index each embedded color
  if (kind === 'shadow') {
    for (const c of extractColorsFromCompound(norm)) {
      if (!shadowColorIndex.has(c)) shadowColorIndex.set(c, []);
      shadowColorIndex.get(c).push(t);
    }
  }
  // For gradient tokens, index each embedded stop color
  if (kind === 'gradient') {
    for (const c of extractColorsFromCompound(norm)) {
      if (!gradientColorIndex.has(c)) gradientColorIndex.set(c, []);
      gradientColorIndex.get(c).push(t);
    }
  }

  if (!tokensBySubsystem.has(t.subsystem)) tokensBySubsystem.set(t.subsystem, []);
  tokensBySubsystem.get(t.subsystem).push(t);
}

// ──────────────────────────────────────────────────────────────────────────
// 5. Config
// ──────────────────────────────────────────────────────────────────────────

const UNIVERSAL_SUBSYSTEMS = new Set([
  'base', 'derived', 'borders', 'text', 'semantic', 'labels',
]);

// Element-role → compatible valueKind set
const ROLE_COMPAT = {
  color:    new Set(['color', 'rgba']),
  rgba:     new Set(['color', 'rgba']),
  gradient: new Set(['gradient']),
  shadow:   new Set(['shadow']),
};

// ──────────────────────────────────────────────────────────────────────────
// 6. Element-role inferrer
// ──────────────────────────────────────────────────────────────────────────

function inferElementRole(match) {
  const mt = (match.matchedText || '').trim();
  const hint = (match.elementHint || '').toLowerCase();
  const ctx  = (match.surroundingContext || '').toLowerCase();

  // Match-level overrides
  if (/^(linear|radial|conic)-gradient\(/i.test(mt)) return 'gradient';
  if (match.kind === 'gradient-linear') return 'gradient';

  // Shadow cues
  if (hint === 'shadow'
      || /\bbox-shadow\s*:/i.test(ctx)
      || /\btext-shadow\s*:/i.test(ctx)
      || /shadowcolor/i.test(ctx)) {
    return 'shadow';
  }

  // rgba/hex kind-based fallback (applied at end)
  const matchKindIsColor = match.kind === 'hex' || match.kind === 'named';
  const matchKindIsRgba  = match.kind === 'rgba';

  // fg / text / color / fill / stroke / border / bg all use single-color tokens
  if (/^(fg|bg|border|canvas-fill|canvas-stroke|stroke|outline|color|fill)$/i.test(hint)
      || /color$/i.test(hint)) {
    return matchKindIsRgba ? 'rgba' : 'color';
  }

  // Gradient stop → that stop's color
  if (hint === 'gradient-stop') {
    return matchKindIsRgba ? 'rgba' : 'color';
  }

  // Fallback by matchedText form
  if (matchKindIsRgba) return 'rgba';
  return 'color';
}

// ──────────────────────────────────────────────────────────────────────────
// 7. FALSE-POSITIVE preservation (from v1)
// ──────────────────────────────────────────────────────────────────────────

const v1Path = path.resolve(__dirname, 'theming-audit-enriched.json');
if (!fs.existsSync(v1Path)) {
  console.error('ERROR: theming-audit-enriched.json not found.');
  process.exit(1);
}
const v1 = JSON.parse(fs.readFileSync(v1Path, 'utf8'));

const fpKeys = new Set();
const v1FPByKey = new Map();
for (const m of v1.matches) {
  if (m.confidence === 'false-positive') {
    const key = `${m.path}:${m.line}:${m.column}`;
    fpKeys.add(key);
    v1FPByKey.set(key, m);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 8. Classifier
// ──────────────────────────────────────────────────────────────────────────

function classify(match) {
  const key = `${match.path}:${match.line}:${match.column}`;
  // FP short-circuit
  if (fpKeys.has(key)) {
    const fp = v1FPByKey.get(key);
    return {
      proposedTokenName: null,
      confidence: 'false-positive',
      assignmentRule: fp.assignmentRule,
      rationale: fp.rationale,
      gatesPassed: ['false-positive-preserved'],
    };
  }

  const role = inferElementRole(match);
  const normalized = normalizeValue(match.matchedText);

  // Gate 1 — value equality
  let candidates;
  if (role === 'shadow') {
    // Match embedded rgba → shadow-tokens carrying that color
    candidates = (shadowColorIndex.get(normalized) || []).slice();
  } else if (role === 'gradient') {
    // If the match is itself a gradient literal, full-value lookup; else
    // it's a stop-color pointing to a gradient token.
    candidates = (valueIndex.get(normalized) || []).slice();
    if (candidates.length === 0) {
      candidates = (gradientColorIndex.get(normalized) || []).slice();
    }
  } else {
    candidates = (valueIndex.get(normalized) || []).slice();
    // For single-color matches inside a gradient-stop context, also allow
    // embedded-stop hits on gradient tokens.
    if (match.elementHint === 'gradient-stop' && candidates.length === 0) {
      candidates = (gradientColorIndex.get(normalized) || []).slice();
    }
  }
  if (candidates.length === 0) {
    return {
      proposedTokenName: null,
      confidence: 'no-fit',
      assignmentRule: 'v2-no-fit',
      rationale: `Gate 1 failed: no catalog token resolves to "${normalized}" (role=${role}).`,
      gatesPassed: [],
    };
  }
  const gatesPassed = ['value'];

  // Gate 2 — capability (value-kind ↔ element-role)
  const compat = ROLE_COMPAT[role] || new Set();
  candidates = candidates.filter(t => {
    const k = valueKindIndex[t.name];
    // shadow tokens matched via shadow-color index, gradient tokens via stop
    // index: accept those when the role matches even if kind !== rgba
    if (role === 'shadow' && k === 'shadow') return true;
    if (role === 'gradient' && k === 'gradient') return true;
    if (role === 'gradient' && (k === 'color' || k === 'rgba')) return false;
    return compat.has(k);
  });
  if (candidates.length === 0) {
    return {
      proposedTokenName: null,
      confidence: 'no-fit',
      assignmentRule: 'v2-no-fit',
      rationale: `Gate 2 failed: value matches but no candidate has value-kind compatible with role=${role}.`,
      gatesPassed,
    };
  }
  gatesPassed.push('capability');

  // Gate 3 — subsystem scope (OR crossSubsystem)
  const subsystem = match.subsystem;
  const byBranch = { same: [], universal: [], crossSub: [] };
  for (const t of candidates) {
    if (t.subsystem === subsystem) byBranch.same.push(t);
    else if (UNIVERSAL_SUBSYSTEMS.has(t.subsystem)) byBranch.universal.push(t);
    else if (t.crossSubsystem === true) byBranch.crossSub.push(t);
  }
  const passed = byBranch.same.concat(byBranch.universal).concat(byBranch.crossSub);
  if (passed.length === 0) {
    return {
      proposedTokenName: null,
      confidence: 'no-fit',
      assignmentRule: 'v2-no-fit',
      rationale: `Gate 3 failed: no candidate in subsystem "${subsystem}" or universal or crossSubsystem.`,
      gatesPassed,
    };
  }
  candidates = passed;
  // Record which subsystem branch(es) fired; prefer same > universal > crossSub.
  let subBranch;
  if (byBranch.same.length > 0) subBranch = 'subsystem:same';
  else if (byBranch.universal.length > 0) subBranch = 'subsystem:universal';
  else subBranch = 'subsystem:crossSubsystem';
  gatesPassed.push(subBranch);

  // Single candidate after Gate 3 → HIGH
  if (candidates.length === 1) {
    return {
      proposedTokenName: candidates[0].name,
      confidence: 'high',
      assignmentRule: 'v2-gate-single-candidate',
      rationale: `Unique Gate 1–3 survivor: ${candidates[0].name}.`,
      gatesPassed,
    };
  }

  // Gate 4 — priority tie-break. Hint-specificity runs BEFORE the subsystem
  // branch so that generic hints ("bg", "fg", "border") can pull a universal
  // base/derived root out of the noise when a same-subsystem pass-through
  // ref (derived-var wrapper around the same base) is coincidentally in the
  // Gate 3 survivor set. Example: sampler's #1A1A24 "bg" resolves to
  // --theme-bg-surface rather than --theme-sampler-arp-cell-inactive, which
  // is merely a derived-var alias for bg-surface.

  // Rule 2 (first): more-specific element-name substring beats less-specific.
  const hintPhrase = [
    match.elementHint || '',
    match.dispatchSelector || '',
    // Surrounding-context property name (e.g. "background" in "background: #xxx")
    (match.surroundingContext || '').toLowerCase(),
  ].join(' ').toLowerCase();

  // Whole-word tokenize the hint phrase so spurious sub-word hits like
  // "on" inside "function" don't score. Keywords like "bg", "fg" are only
  // credited if they appear as whole tokens (e.g. as elementHint "bg" or
  // the word "bg" in a selector); "drawBackground" splits to "draw" +
  // "background" and does NOT produce a "bg" hit.
  const hintWords = new Set(
    hintPhrase
      .split(/[^a-z0-9]+/)
      .flatMap(w => {
        // Split camelCase too: "drawBackground" → "draw", "background"
        return w.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/\s+/);
      })
      .filter(Boolean)
  );

  // Rule 2a — alias pruning (runs BEFORE the hint-specificity scoring).
  // Drop `derived-var` candidates whose `ref` is also in the survivor pool
  // AND whose *semantic tail* words are absent from the hint phrase. A
  // token's semantic tail is its name minus its subsystem prefix and minus
  // the generic role words {fg,bg,color,fill,stroke,border,handle,default}.
  //
  // Why this runs first: without it, an alias like
  // `--theme-sampler-envelope-handle` (= var(--theme-text)) wins Rule 2
  // purely on its subsystem prefix ("sampler" from the CSS selector), even
  // though the context never mentions "envelope"/"handle". The result is
  // that generic `color: #E8E8ED` inside any .sampler-* rule drags in an
  // unrelated specialized alias. Rule 2a drops these pass-through aliases
  // unless the context gives the alias's tail a semantic grounding.
  const GENERIC_ROLE_WORDS = new Set([
    'fg', 'bg', 'color', 'fill', 'stroke', 'border', 'default', 'subtle',
  ]);
  const subsystemWords = new Set(
    (match.subsystem || '').split(/[.\-]/).filter(Boolean)
  );
  function semanticTail(t) {
    const tail = t.name.replace(/^--theme-/, '').toLowerCase().split('-');
    return tail.filter(p => !subsystemWords.has(p) && !GENERIC_ROLE_WORDS.has(p));
  }
  if (candidates.length > 1) {
    const names = new Set(candidates.map(t => t.name));
    // Part 1: drop derived-var aliases whose ref is in pool and tail is ungrounded.
    let kept = candidates.filter(t => {
      if (t.derivation.type !== 'derived-var') return true;
      if (!names.has(t.derivation.ref)) return true;
      const tail = semanticTail(t);
      if (tail.length === 0) return false; // pure pass-through alias → drop
      const hasSemanticGrounding = tail.some(w => hintWords.has(w));
      return hasSemanticGrounding;
    });
    // Part 2: when a universal base/derived-formula candidate is in the pool,
    // drop same-subsystem specific (explicit/derived-formula) candidates whose
    // semantic tail is ungrounded in context AND whose value is also served
    // by other same-subsystem candidates. The "multiple same-sub candidates
    // with same value" signal indicates the value is a "reuse color" (e.g.
    // the accent color tinting many LFO/envelope tokens), not a unique
    // semantic. Example: --theme-sampler-lfo-color-volume (#33CED6) beats
    // --theme-accent on a focus border because subsystem matches, but many
    // other sampler tokens also resolve to #33CED6, so dropping the specific
    // alias and letting the base win is correct. Conversely, if there's
    // exactly one same-sub token with a given value (e.g.
    // --theme-preview-loaded-bg at #111118 is unique in preview-player), the
    // catalog curator deliberately assigned that role, so we keep it.
    const hasUniversalBase = kept.some(
      t => UNIVERSAL_SUBSYSTEMS.has(t.subsystem)
        && (t.derivation.type === 'base' || t.derivation.type === 'derived-formula')
    );
    if (hasUniversalBase) {
      const sameSubCount = kept.filter(t => t.subsystem === subsystem).length;
      if (sameSubCount >= 2) {
        kept = kept.filter(t => {
          if (t.subsystem !== subsystem) return true;
          if (t.derivation.type !== 'explicit' && t.derivation.type !== 'derived-formula') return true;
          const tail = semanticTail(t);
          if (tail.length === 0) return false;
          const hasSemanticGrounding = tail.some(w => hintWords.has(w));
          return hasSemanticGrounding;
        });
      }
    }
    if (kept.length >= 1 && kept.length < candidates.length) {
      candidates = kept;
      byBranch.same      = candidates.filter(t => t.subsystem === subsystem);
      byBranch.universal = candidates.filter(t => UNIVERSAL_SUBSYSTEMS.has(t.subsystem) && t.subsystem !== subsystem);
      byBranch.crossSub  = candidates.filter(t => t.crossSubsystem === true && t.subsystem !== subsystem && !UNIVERSAL_SUBSYSTEMS.has(t.subsystem));
    }
  }

  if (candidates.length === 1) {
    return {
      proposedTokenName: candidates[0].name,
      confidence: 'medium',
      assignmentRule: 'v2-gate-tiebreak-alias-prune',
      rationale: `Alias-prune resolved tie by dropping pass-through derived-var aliases: ${candidates[0].name}.`,
      gatesPassed,
    };
  }

  // Score a token's name against the hint phrase. Returns:
  //   matchedLen — sum of char-lengths of name parts appearing as whole words
  //                in the hint phrase
  //   coverage   — fraction of name parts that matched (matched/total)
  // Coverage penalizes "over-specified" names (e.g. --theme-sampler-key-border
  // scores 1/3 on a generic border hint, while --theme-border-subtle scores
  // 1/2 — the latter is less over-specified so it wins on ties).
  function hintScore(t) {
    const tail = t.name.replace(/^--theme-/, '').toLowerCase();
    // Exclude subsystem-name words: they're already encoded in Gate 3, so
    // crediting them here is double-counting. E.g. `--theme-sampler-lfo-color-volume`
    // in subsystem=sampler would score an extra 7 chars from "sampler" just
    // because the CSS selector contained ".sampler-panel-field", even when
    // "lfo"/"volume" never appear in context. Strip subsystem tokens so the
    // score reflects only the semantic-tail match.
    const parts = tail.split('-').filter(p => !subsystemWords.has(p));
    if (parts.length === 0) return { matchedLen: 0, coverage: 0 };
    let matchedLen = 0;
    let matchedCount = 0;
    for (const p of parts) {
      if (hintWords.has(p)) { matchedLen += p.length; matchedCount++; }
    }
    return { matchedLen, coverage: matchedCount / parts.length };
  }

  if (candidates.length > 1 && hintPhrase.length > 0) {
    const scored = candidates.map(t => ({ t, ...hintScore(t) }));
    const maxLen = Math.max(...scored.map(s => s.matchedLen));
    if (maxLen > 0) {
      let winners = scored.filter(s => s.matchedLen === maxLen);
      // Secondary: among tied matchedLen, prefer highest coverage ratio
      // (fewest unexplained specificity parts).
      const maxCov = Math.max(...winners.map(s => s.coverage));
      winners = winners.filter(s => s.coverage === maxCov).map(s => s.t);
      if (winners.length < candidates.length) {
        candidates = winners;
        byBranch.same      = candidates.filter(t => t.subsystem === subsystem);
        byBranch.universal = candidates.filter(t => UNIVERSAL_SUBSYSTEMS.has(t.subsystem) && t.subsystem !== subsystem);
        byBranch.crossSub  = candidates.filter(t => t.crossSubsystem === true && t.subsystem !== subsystem && !UNIVERSAL_SUBSYSTEMS.has(t.subsystem));
      }
    }
  }

  if (candidates.length === 1) {
    return {
      proposedTokenName: candidates[0].name,
      confidence: 'medium',
      assignmentRule: 'v2-gate-tiebreak-hint',
      rationale: `Tie resolved by element-hint specificity: ${candidates[0].name}.`,
      gatesPassed,
    };
  }

  // Rule 1: same-subsystem beats universal/crossSub
  // Remember the pre-filter universal+cross pool size; used for LOW demotion.
  const otherSubPoolSize = byBranch.universal.length + byBranch.crossSub.length;
  if (byBranch.same.length > 0) candidates = byBranch.same;
  else if (byBranch.universal.length > 0) candidates = byBranch.universal;
  // else stays as crossSub

  if (candidates.length === 1) {
    const winner = candidates[0];
    // Semantic-anchor check: if the winner's tail has ≥1 word, none of which
    // appears in hintWords, AND at least 2 other-subsystem value-equivalent
    // candidates existed in Gate 3, the winner is a "subsystem-only" pick —
    // i.e. the catalog has no semantically-anchored token for this site, and
    // the same-sub winner is coincidentally value-equal. Demote to LOW so the
    // review surfaces these as "catalog gap, not true MEDIUM" rather than
    // rubber-stamping an unrelated token that happens to share the value.
    const winnerTail = semanticTail(winner).filter(p => !GENERIC_ROLE_WORDS.has(p));
    const isUnanchored = winnerTail.length > 0 && !winnerTail.some(w => hintWords.has(w));
    if (isUnanchored && otherSubPoolSize >= 2) {
      return {
        proposedTokenName: winner.name,
        confidence: 'low',
        assignmentRule: 'v2-gate-tiebreak-subsystem-unanchored',
        rationale: `Subsystem-only match: ${winner.name} is value-equal but its semantic tail [${winnerTail.join(', ')}] is absent from the context. Other-subsystem value-equivalents: ${otherSubPoolSize}. Likely a catalog gap, not a true MEDIUM.`,
        gatesPassed,
      };
    }
    return {
      proposedTokenName: winner.name,
      confidence: 'medium',
      assignmentRule: 'v2-gate-tiebreak-subsystem',
      rationale: `Tie resolved by subsystem priority (same > universal > crossSub): ${winner.name}.`,
      gatesPassed,
    };
  }

  // Rule 3: explicit > derived-formula > derived-var > base
  const derivPriority = (t) => {
    switch (t.derivation.type) {
      case 'explicit': return 3;
      case 'derived-formula': return 2;
      case 'derived-var': return 1;
      case 'base': return 0;
      default: return -1;
    }
  };
  const maxPriority = Math.max(...candidates.map(derivPriority));
  const byPriority = candidates.filter(t => derivPriority(t) === maxPriority);
  if (byPriority.length === 1) {
    return {
      proposedTokenName: byPriority[0].name,
      confidence: 'medium',
      assignmentRule: 'v2-gate-tiebreak-derivation',
      rationale: `Tie resolved by derivation priority (explicit > formula > var > base): ${byPriority[0].name}.`,
      gatesPassed,
    };
  }

  // Rule 4: alphabetical + LOW
  const sorted = byPriority.slice().sort((a, b) => a.name.localeCompare(b.name));
  return {
    proposedTokenName: sorted[0].name,
    confidence: 'low',
    assignmentRule: 'v2-gate-tiebreak-alphabetical',
    rationale: `Unresolved tie after subsystem/hint/derivation gates; alphabetical fallback. Tied candidates: ${sorted.map(t=>t.name).join(', ')}`,
    gatesPassed,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 9. Run classifier over all matches
// ──────────────────────────────────────────────────────────────────────────

const out = [];
for (const m of v1.matches) {
  const r = classify(m);
  out.push({
    path: m.path,
    line: m.line,
    column: m.column,
    matchedText: m.matchedText,
    kind: m.kind,
    subsystem: m.subsystem,
    originalSubsystem: m.originalSubsystem,
    dispatch: m.dispatch,
    dispatchSelector: m.dispatchSelector,
    elementHint: m.elementHint,
    surroundingContext: m.surroundingContext,
    ambiguous: m.ambiguous,
    ambiguityReason: m.ambiguityReason,
    proposedTokenName: r.proposedTokenName,
    confidence: r.confidence,
    assignmentRule: r.assignmentRule,
    rationale: r.rationale,
    reSubsystemed: m.reSubsystemed || false,
    classifierVersion: 'v2',
    gatesPassed: r.gatesPassed,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// 10. Integrity checks
// ──────────────────────────────────────────────────────────────────────────

const assertions = [];
function assert(ok, label, detail = '') {
  assertions.push({ ok: !!ok, label, detail });
}

// 1. entry count
assert(out.length === 584, '#1 entries.length === 584', `got ${out.length}`);

// 2. every proposedTokenName exists
{
  const bad = out.filter(e => e.proposedTokenName && !TOKENS_BY_NAME[e.proposedTokenName]);
  assert(bad.length === 0, '#2 every non-null proposedTokenName exists in catalog', `bad: ${bad.length}`);
}

// 3. HIGH/MEDIUM: normalize(resolveChain[token]) === normalize(matchedText)
//    Relaxed for shadow/gradient: embedded color equality is required.
{
  const bad = [];
  for (const e of out) {
    if (e.confidence !== 'high' && e.confidence !== 'medium') continue;
    if (!e.proposedTokenName) continue;
    const tokLeaf = resolveChain[e.proposedTokenName];
    if (!tokLeaf) { bad.push(`${e.path}:${e.line} — missing leaf for ${e.proposedTokenName}`); continue; }
    const tokNorm = normalizeValue(tokLeaf);
    const matchNorm = normalizeValue(e.matchedText);
    const tokKind = valueKindIndex[e.proposedTokenName];
    if (tokNorm === matchNorm) continue;
    if (tokKind === 'shadow' || tokKind === 'gradient') {
      // Embedded-color equality acceptable for these kinds.
      const embedded = extractColorsFromCompound(tokNorm);
      if (embedded.includes(matchNorm)) continue;
    }
    bad.push(`${e.path}:${e.line} — "${matchNorm}" vs ${e.proposedTokenName}→"${tokNorm}"`);
  }
  assert(bad.length === 0, '#3 HIGH/MEDIUM value-equality (incl. embedded for shadow/gradient)',
    bad.length ? `first: ${bad[0]} (total ${bad.length})` : '');
}

// 4. HIGH/MEDIUM: valueKind ∈ compatible set for inferred role
{
  const bad = [];
  for (const e of out) {
    if (e.confidence !== 'high' && e.confidence !== 'medium') continue;
    if (!e.proposedTokenName) continue;
    const role = inferElementRole(e);
    const kind = valueKindIndex[e.proposedTokenName];
    if (!ROLE_COMPAT[role]) { bad.push(`${e.path}:${e.line} — unknown role ${role}`); continue; }
    // Shadow/gradient token kinds are valid for shadow/gradient roles respectively.
    const ok = (role === 'shadow' && kind === 'shadow')
            || (role === 'gradient' && kind === 'gradient')
            || ROLE_COMPAT[role].has(kind);
    if (!ok) bad.push(`${e.path}:${e.line} — role=${role} but ${e.proposedTokenName}.kind=${kind}`);
  }
  assert(bad.length === 0, '#4 HIGH/MEDIUM capability gate',
    bad.length ? `first: ${bad[0]} (total ${bad.length})` : '');
}

// 5. Every assignment: token.subsystem === match.subsystem OR universal OR crossSubsystem
{
  const bad = [];
  for (const e of out) {
    if (!e.proposedTokenName) continue;
    if (e.confidence === 'false-positive') continue;
    const t = TOKENS_BY_NAME[e.proposedTokenName];
    const ok = t.subsystem === e.subsystem
            || UNIVERSAL_SUBSYSTEMS.has(t.subsystem)
            || t.crossSubsystem === true;
    if (!ok) bad.push(`${e.path}:${e.line} — ${e.proposedTokenName} sub=${t.subsystem} vs match.sub=${e.subsystem}`);
  }
  assert(bad.length === 0, '#5 assignment subsystem gate',
    bad.length ? `first: ${bad[0]} (total ${bad.length})` : '');
}

// 6. FALSE-POSITIVE count === 9; each byte-identical to v1 on key fields.
{
  const fps = out.filter(e => e.confidence === 'false-positive');
  let ok = fps.length === 9;
  let detail = `count=${fps.length}`;
  if (ok) {
    for (const e of fps) {
      const key = `${e.path}:${e.line}:${e.column}`;
      const v1m = v1FPByKey.get(key);
      if (!v1m || v1m.matchedText !== e.matchedText) {
        ok = false;
        detail = `divergence at ${key}`;
        break;
      }
    }
  }
  assert(ok, '#6 FALSE-POSITIVE preserved (count=9, byte-identical keys)', detail);
}

// 7. Every NO-FIT has non-empty rationale citing a gate
{
  const bad = [];
  for (const e of out) {
    if (e.confidence !== 'no-fit') continue;
    if (!e.rationale || !/Gate \d failed/.test(e.rationale)) {
      bad.push(`${e.path}:${e.line} — "${e.rationale}"`);
    }
  }
  assert(bad.length === 0, '#7 every NO-FIT rationale cites a gate',
    bad.length ? `first: ${bad[0]} (total ${bad.length})` : '');
}

// ──────────────────────────────────────────────────────────────────────────
// 11. Unit-asserts for normalizer (defensive coverage per plan)
// ──────────────────────────────────────────────────────────────────────────

const unitAsserts = [];
function uassert(actual, expected, label) {
  unitAsserts.push({ ok: actual === expected, actual, expected, label });
}
// Hex case-insensitivity
uassert(normalizeValue('#FFFFFF'), '#ffffff', 'hex upper→lower');
uassert(normalizeValue('#AbCdEf'), '#abcdef', 'hex mixed-case→lower');
// 3-digit → 6-digit
uassert(normalizeValue('#fff'), '#ffffff', '3-digit → 6-digit');
uassert(normalizeValue('#abc'), '#aabbcc', '3-digit expand');
// rgba whitespace variants
uassert(normalizeValue('rgba(0,0,0,0.6)'),       'rgba(0, 0, 0, 0.6)', 'rgba no-space');
uassert(normalizeValue('rgba( 0, 0, 0, 0.6 )'),  'rgba(0, 0, 0, 0.6)', 'rgba inside-space');
uassert(normalizeValue('RGBA( 51 , 206 , 214 , 0.35 )'), 'rgba(51, 206, 214, 0.35)', 'rgba uppercase + spaces');
// Gradient function-name casing
uassert(
  normalizeValue('LINEAR-GRADIENT(180deg, #FFF, #000)'),
  'linear-gradient(180deg, #ffffff, #000000)',
  'gradient uppercase function'
);
// Named color: black
uassert(normalizeValue('black'), '#000000', 'named black → #000000');

// F1 — multi-shadow segmentation test: two top-level shadow compounds
const multiShadow = '0 2px 4px rgba(0,0,0,0.3), inset 0 0 0 1px rgba(255,255,255,0.1)';
const multiNorm = normalizeValue(multiShadow);
uassert(
  multiNorm,
  '0 2px 4px rgba(0, 0, 0, 0.3), inset 0 0 0 1px rgba(255, 255, 255, 0.1)',
  'F1 multi-shadow preserved with normalized embedded rgbas'
);
// F1 — both embedded colors extractable independently
{
  const colors = extractColorsFromCompound(multiNorm);
  uassert(
    colors.includes('rgba(0, 0, 0, 0.3)') && colors.includes('rgba(255, 255, 255, 0.1)'),
    true,
    'F1 both shadow segments resolve independently'
  );
}

// ──────────────────────────────────────────────────────────────────────────
// 12. Write output + print summaries
// ──────────────────────────────────────────────────────────────────────────

const tierCounts = { high: 0, medium: 0, low: 0, 'no-fit': 0, 'false-positive': 0 };
for (const e of out) tierCounts[e.confidence]++;

const noFitValues = new Map(); // normalized → count
for (const e of out) {
  if (e.confidence === 'no-fit') {
    const n = normalizeValue(e.matchedText);
    noFitValues.set(n, (noFitValues.get(n) || 0) + 1);
  }
}
const topNoFit = [...noFitValues.entries()].sort((a,b) => b[1]-a[1]).slice(0, 20);

const outPath = path.resolve(__dirname, 'theming-audit-enriched-v2.json');
const payload = {
  generatedAt: new Date().toISOString(),
  classifierVersion: 'v2',
  totalColorMatches: out.length,
  tierCounts,
  entries: out,
};
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

console.log('\n=== theming-audit-enrich-v2 ===\n');
console.log('Tier counts:');
for (const [k, v] of Object.entries(tierCounts)) console.log(`  ${k.padEnd(16)} ${v}`);
console.log('');
console.log('Top 20 NO-FIT values:');
topNoFit.forEach(([v, c]) => console.log(`  ${String(c).padStart(3)}  ${v}`));
console.log('');
console.log('Normalizer unit asserts:');
let uAllOk = true;
for (const u of unitAsserts) {
  if (!u.ok) { uAllOk = false; console.log(`  ✖ ${u.label}  expected="${u.expected}"  actual="${u.actual}"`); }
}
if (uAllOk) console.log(`  ✔ ${unitAsserts.length} normalizer asserts all pass`);
console.log('');
console.log('Integrity assertions:');
let allOk = true;
for (const a of assertions) {
  const icon = a.ok ? '✔' : '✖';
  const suffix = a.detail ? ` — ${a.detail}` : '';
  console.log(`  ${icon} ${a.label}${suffix}`);
  if (!a.ok) allOk = false;
}
console.log('');
console.log(`Output written: ${path.relative(process.cwd(), outPath)}`);
if (!allOk || !uAllOk) {
  console.log('\n✖ Integrity FAILED — classifier bug.\n');
  process.exit(1);
}
console.log('\n✔ All integrity checks pass.\n');
