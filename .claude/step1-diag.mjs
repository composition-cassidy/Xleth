// Step 1 diagnostic — read-only analysis of catalog vs enriched audit.
// Emits structured JSON to stdout for formatting by the outer workflow.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const catalog = require('../ui/node_modules/.theming-verify-cache/catalog.cjs');
const { resolveTheme } = require('../ui/node_modules/.theming-verify-cache/applyTheme.bundle.cjs');

const themeFile = JSON.parse(fs.readFileSync('./ui/src/theming/shipped/xleth-default.json', 'utf8'));
const enriched = JSON.parse(fs.readFileSync('./scripts/theming-audit-enriched.json', 'utf8'));

const resolved = resolveTheme(themeFile);
const { TOKENS, SUBSYSTEMS, TOKENS_BY_NAME } = catalog;

// ─── helpers ─────────────────────────────────────────────────────────────
const NAMED_COLORS = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
  gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000', olive: '#808000',
  lime: '#00ff00', aqua: '#00ffff', cyan: '#00ffff', teal: '#008080', navy: '#000080',
  fuchsia: '#ff00ff', magenta: '#ff00ff', purple: '#800080', orange: '#ffa500', yellow: '#ffff00',
  pink: '#ffc0cb', brown: '#a52a2a', coral: '#ff7f50', gold: '#ffd700', indigo: '#4b0082',
  violet: '#ee82ee', khaki: '#f0e68c', crimson: '#dc143c', tomato: '#ff6347', salmon: '#fa8072',
  plum: '#dda0dd', orchid: '#da70d6', turquoise: '#40e0d0', wheat: '#f5deb3', tan: '#d2b48c',
  darkgray: '#a9a9a9', darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3',
  dimgray: '#696969', dimgrey: '#696969',
  transparent: 'transparent',
};

function normalizeColor(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  // named color
  const lower = s.toLowerCase();
  if (NAMED_COLORS[lower]) return NAMED_COLORS[lower];
  // hex
  const hex3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
  const hex6 = /^#[0-9a-f]{6}$/i;
  const hex8 = /^#[0-9a-f]{8}$/i;
  if (hex3.test(s)) {
    const m = s.match(hex3);
    return '#' + m[1]+m[1]+m[2]+m[2]+m[3]+m[3];
  }
  if (hex6.test(s)) return s.toLowerCase();
  if (hex8.test(s)) return s.toLowerCase();
  // rgba/rgb/hsla/hsl: normalize whitespace
  const fn = s.match(/^(rgba?|hsla?)\s*\(([^)]+)\)\s*$/i);
  if (fn) {
    const name = fn[1].toLowerCase();
    const parts = fn[2].split(',').map(p => p.trim());
    return `${name}(${parts.join(', ')})`;
  }
  // gradients
  const grad = s.match(/^(linear|radial|conic)-gradient\s*\((.*)\)\s*$/is);
  if (grad) {
    const kind = grad[1].toLowerCase();
    // normalize inner: split on top-level commas
    const inner = grad[2];
    const stops = splitTopLevelCommas(inner).map(p => p.trim());
    // normalize each stop's rgb/rgba inner whitespace
    const normStops = stops.map(normalizeGradientStop);
    return `${kind}-gradient(${normStops.join(', ')})`;
  }
  // shadow compound: keep as-is with whitespace collapsed
  if (/\brgba?\s*\(/.test(s) || /#[0-9a-f]{3,8}/i.test(s)) {
    return s.replace(/\s+/g, ' ').trim();
  }
  return s;
}

function splitTopLevelCommas(str) {
  const out = []; let depth = 0; let buf = '';
  for (const ch of str) {
    if (ch === '(') { depth++; buf += ch; continue; }
    if (ch === ')') { depth--; buf += ch; continue; }
    if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.length) out.push(buf);
  return out;
}

function normalizeGradientStop(stop) {
  // stop may be "rgba(51, 206, 214, 0.08) 0%" etc
  return stop.replace(/(rgba?|hsla?)\s*\(([^)]+)\)/gi, (_, fn, inner) => {
    const parts = inner.split(',').map(p => p.trim());
    return `${fn.toLowerCase()}(${parts.join(', ')})`;
  }).replace(/#[0-9A-F]{3,8}/gi, (m) => m.toLowerCase()).replace(/\s+/g, ' ').trim();
}

function inferValueKind(value) {
  if (!value) return 'unknown';
  const v = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return 'color';
  if (/^rgba?\(/i.test(v)) return 'rgba';
  if (/^hsla?\(/i.test(v)) return 'rgba';
  if (/^(linear|radial|conic)-gradient\(/i.test(v)) return 'gradient';
  if (v === 'transparent') return 'rgba';
  if (/^(inset\s+)?-?\d+px\s+-?\d+px/i.test(v)) return 'shadow';
  if (/^\d+(\.\d+)?(px|rem|em|%|vh|vw|ch|pt)$/i.test(v)) return 'dimension';
  if (/^\d+(\.\d+)?$/.test(v)) return 'opacity';
  if (/^\d+ms$/i.test(v) || /^\d+(\.\d+)?s$/i.test(v)) return 'duration';
  return 'other';
}

// ─── build resolveChain + valueIndex + valueKindIndex ────────────────────
const resolveChain = {}; // tokenName → leaf value string
const valueKindIndex = {};
const unresolvable = [];

for (const t of TOKENS) {
  let current = t.name;
  let steps = 0;
  let leaf = null;
  while (steps < 40) {
    const def = TOKENS_BY_NAME[current];
    if (!def) break;
    if (def.derivation.type === 'derived-var') {
      current = def.derivation.ref;
      steps++;
      continue;
    }
    leaf = resolved.values[current];
    break;
  }
  if (leaf == null) { unresolvable.push(t.name); continue; }
  resolveChain[t.name] = leaf;
  valueKindIndex[t.name] = inferValueKind(leaf);
}

// build value index keyed on normalized value
const valueIndex = new Map();
for (const [name, val] of Object.entries(resolveChain)) {
  const norm = normalizeColor(val);
  if (!norm) continue;
  if (!valueIndex.has(norm)) valueIndex.set(norm, []);
  valueIndex.get(norm).push(name);
}

// ─── match dataset ───────────────────────────────────────────────────────
const matches = enriched.matches || enriched; // older shape fallback
const allMatches = Array.isArray(matches) ? matches : (matches.entries || Object.values(matches).flat());
console.error('DEBUG: matches sample', JSON.stringify(allMatches[0]).slice(0, 300));
console.error('DEBUG: total matches', allMatches.length);

// ─── Gate 2 capability table ─────────────────────────────────────────────
const CAPABILITY = {
  color:   new Set(['color','rgba']),
  rgba:    new Set(['color','rgba']),
  shadow:  new Set(['shadow']),
  gradient:new Set(['gradient']),
};

function inferMatchRole(m) {
  const text = (m.matchedText || '').trim();
  if (/^(linear|radial|conic)-gradient/i.test(text)) return 'gradient';
  const ctx = (m.surroundingContext || '').toLowerCase();
  const hint = (m.elementHint || '').toLowerCase();
  // shadow cues
  if (hint.includes('shadow') || /\bbox-shadow\b|\btext-shadow\b|shadowcolor/i.test(ctx)) return 'shadow';
  // gradient cues (non-matched-text)
  if (/gradient-stop|addcolorstop/.test(hint) || /gradient\(/.test(ctx)) {
    // if matched text is a single color, it's a gradient stop color → still 'color' for value-equality but we record stop context
    return /^rgba?/i.test(text) ? 'rgba' : 'color';
  }
  if (/^rgba?/i.test(text)) return 'rgba';
  if (/^#/.test(text)) return 'color';
  return 'color';
}

// ─── drift scan ──────────────────────────────────────────────────────────
// Build per-value match occurrences
const valueOccurrences = new Map(); // normValue → [{path, line, subsystem, elementHint, matchedText}]
for (const m of allMatches) {
  if (m.kind === 'rgba' && m.matchedText === 'rgba(') continue; // skip FP
  const n = normalizeColor(m.matchedText);
  if (!n) continue;
  if (!valueOccurrences.has(n)) valueOccurrences.set(n, []);
  valueOccurrences.get(n).push({
    path: m.path, line: m.line, col: m.column,
    subsystem: m.subsystem, elementHint: m.elementHint,
    matchedText: m.matchedText,
    priorConfidence: m.confidence, priorToken: m.proposedTokenName,
  });
}

// For each non-derived-var token with a concrete resolved value:
//  - zero occurrences of value in enriched → SUSPECT drift
//  - occurrences but none within token's subsystem → CROSS-SUBSYSTEM drift (likely mis-subsystemed)
//  - occurrences mixed: occurrences within wrong subsystem too → NOTE (cross-use, possibly expected)
const driftReport = [];
for (const t of TOKENS) {
  if (t.derivation.type === 'derived-var') continue;
  const leaf = resolveChain[t.name];
  if (!leaf) continue;
  const kind = valueKindIndex[t.name];
  if (!['color','rgba','gradient','shadow'].includes(kind)) continue;
  const n = normalizeColor(leaf);
  const occ = (valueOccurrences.get(n) || []).slice();
  if (occ.length === 0) {
    driftReport.push({
      token: t.name, subsystem: t.subsystem, value: leaf, kind,
      verdict: 'suspect-drift',
      note: 'value does not appear anywhere in 584 matches',
      inSubsystem: 0, outSubsystem: 0, totalOcc: 0,
    });
    continue;
  }
  const inSub = occ.filter(o => o.subsystem === t.subsystem);
  const outSub = occ.filter(o => o.subsystem !== t.subsystem);
  if (inSub.length === 0) {
    driftReport.push({
      token: t.name, subsystem: t.subsystem, value: leaf, kind,
      verdict: 'cross-subsystem-drift',
      note: `value appears ${outSub.length}× but never in subsystem ${t.subsystem}; used in: ${[...new Set(outSub.map(o=>o.subsystem))].join(', ')}`,
      inSubsystem: 0, outSubsystem: outSub.length, totalOcc: occ.length,
      examples: outSub.slice(0,3).map(o => `${o.path}:${o.line} (${o.subsystem}, ${o.elementHint||'-'})`),
    });
    continue;
  }
  // Hits in own subsystem — OK; but also flag if values for the token's name exist elsewhere with different values
  // (skip for now — covered by Gate 3 during classification)
}

// Also look for "token name implies X but value is Y" drifts by inspecting
// catalog tokens whose subsystem has matches where a SIMILAR name keyword
// appears and the value differs. This is harder; we emit a simpler signal:
// enumerate matches whose elementHint or context strongly suggests a token
// (by name keyword) but whose value does not match that token's resolved value.
const nameDrifts = [];
for (const m of allMatches) {
  if (m.confidence === 'false-positive') continue;
  if (!m.proposedTokenName) continue;
  const t = TOKENS_BY_NAME[m.proposedTokenName];
  if (!t) continue;
  const leaf = resolveChain[t.name];
  const nMatch = normalizeColor(m.matchedText);
  const nToken = normalizeColor(leaf);
  if (nMatch !== nToken) {
    nameDrifts.push({
      path: m.path, line: m.line,
      matchedText: m.matchedText, priorToken: m.proposedTokenName,
      tokenValue: leaf, delta: `match=${nMatch} vs token=${nToken}`,
      subsystem: m.subsystem, tokenSubsystem: t.subsystem,
      priorConf: m.confidence,
    });
  }
}

// ─── gap scan ────────────────────────────────────────────────────────────
const UNIVERSAL = new Set(['base','derived','borders','text','semantic','labels']);
const gaps = new Map(); // `${subsystem}|${normValue}|${role}` → {count, examples}
const gateStats = { g1_pass:0, g1_fail:0, g2_pass:0, g2_fail:0, g3_pass:0, g3_fail:0 };

for (const m of allMatches) {
  if (m.confidence === 'false-positive') continue;
  const n = normalizeColor(m.matchedText);
  if (!n) continue;
  const role = inferMatchRole(m);
  // Gate 1
  let cands = valueIndex.get(n) || [];
  if (cands.length === 0) { gateStats.g1_fail++; recordGap(m, role, n); continue; }
  gateStats.g1_pass++;
  // Gate 2
  cands = cands.filter(name => CAPABILITY[role].has(valueKindIndex[name]));
  if (cands.length === 0) { gateStats.g2_fail++; recordGap(m, role, n, 'gate2'); continue; }
  gateStats.g2_pass++;
  // Gate 3
  cands = cands.filter(name => {
    const ts = TOKENS_BY_NAME[name].subsystem;
    return ts === m.subsystem || UNIVERSAL.has(ts);
  });
  if (cands.length === 0) { gateStats.g3_fail++; recordGap(m, role, n, 'gate3'); continue; }
  gateStats.g3_pass++;
}

function recordGap(m, role, n, failedGate='gate1') {
  const key = `${m.subsystem}||${n}||${role}`;
  if (!gaps.has(key)) gaps.set(key, { subsystem: m.subsystem, value: n, role, count: 0, failedGate, examples: [] });
  const g = gaps.get(key);
  g.count++;
  if (g.examples.length < 3) g.examples.push(`${m.path}:${m.line} (hint=${m.elementHint||'-'})`);
}

// ─── named-colors audit ─────────────────────────────────────────────────
const namedColors = new Map(); // raw → { count, examples }
for (const m of allMatches) {
  if (m.kind !== 'named') continue;
  const raw = (m.matchedText || '').trim();
  if (!namedColors.has(raw)) namedColors.set(raw, { count: 0, examples: [], hex: NAMED_COLORS[raw.toLowerCase()] || null });
  const entry = namedColors.get(raw);
  entry.count++;
  if (entry.examples.length < 2) entry.examples.push(`${m.path}:${m.line} (${m.subsystem}, ${m.elementHint||'-'})`);
}

// ─── output ─────────────────────────────────────────────────────────────
const out = {
  catalogStats: {
    totalTokens: TOKENS.length,
    resolvedCount: Object.keys(resolveChain).length,
    unresolvable,
    valueKindDist: {},
  },
  matchStats: {
    total: allMatches.length,
    gate1Pass: gateStats.g1_pass,
    gate1Fail: gateStats.g1_fail,
    gate2Pass: gateStats.g2_pass,
    gate2Fail: gateStats.g2_fail,
    gate3Pass: gateStats.g3_pass,
    gate3Fail: gateStats.g3_fail,
  },
  suspectDrift: driftReport.filter(d => d.verdict === 'suspect-drift'),
  crossSubsystemDrift: driftReport.filter(d => d.verdict === 'cross-subsystem-drift'),
  nameDriftsTop: nameDrifts.slice(0, 50),
  nameDriftsTotal: nameDrifts.length,
  gapsTop30: [...gaps.values()].sort((a,b) => b.count - a.count).slice(0, 30),
  gapsAll: [...gaps.values()].sort((a,b) => b.count - a.count),
  gapsTotal: gaps.size,
  gapsTotalMatches: [...gaps.values()].reduce((a,g) => a+g.count, 0),
  namedColors: [...namedColors.entries()].map(([raw, v]) => ({ raw, ...v })).sort((a,b) => b.count - a.count),
};
for (const k of Object.keys(valueKindIndex)) {
  const vk = valueKindIndex[k];
  out.catalogStats.valueKindDist[vk] = (out.catalogStats.valueKindDist[vk] || 0) + 1;
}

process.stdout.write(JSON.stringify(out, null, 2));
