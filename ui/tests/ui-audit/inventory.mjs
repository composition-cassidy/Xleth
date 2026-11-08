// Builds INVENTORY.md for the UI audit. Read-only: reads source + git, writes only to tests/ui-audit/out/.
// Usage (from ui/):  node tests/ui-audit/inventory.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AUDIO_EFFECTS, VISUAL_EFFECTS, VISUAL_EFFECT_FILES, VISUAL_EFFECT_FILES_EXTRA, FXGRAPH_NODE_TYPES, SURFACES,
} from './surfaces.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, '../..');
const SRC = path.join(UI, 'src');
const REPO = path.resolve(UI, '..');
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

const PHASE0_BASE = '05c8689^'; // first rebuild commit (DESIGN.md, Phase 0 step 1)

const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }).trim();

// ── files ──
const CODE_RE = /\.(jsx?|tsx?)$/;
const isTest = (f) => /\.test\.|__tests__|\.bak$|Fixture/.test(f);
function expand(rel) {
  const abs = path.resolve(SRC, rel);
  if (!rel.endsWith('/')) return fs.existsSync(abs) ? [abs] : [];
  const out = [];
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); }
      else if ((CODE_RE.test(e.name) || e.name.endsWith('.css') || e.name.endsWith('.json')) && !isTest(p)) out.push(p);
    }
  })(abs);
  return out;
}
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').length;

// ── CSS rule index ──
function parseCss(text) {
  const rules = []; // {sel, start, end}
  const stack = [];
  let line = 1; let buf = ''; let bufStartLine = 1; let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); const chunk = text.slice(i, e < 0 ? text.length : e + 2); line += (chunk.match(/\n/g) || []).length; i += chunk.length; continue; }
    if (c === '"' || c === "'") { const q = c; let j = i + 1; while (j < text.length && text[j] !== q) { if (text[j] === '\\') j++; j++; } buf += text.slice(i, j + 1); i = j + 1; continue; }
    if (c === '\n') { line++; buf += c; i++; continue; }
    if (c === '{') {
      const sel = buf.trim();
      stack.push({ sel, start: bufStartLine, container: sel.startsWith('@') });
      buf = ''; bufStartLine = line; i++; continue;
    }
    if (c === '}') {
      const top = stack.pop();
      if (top && !top.container) {
        const inKeyframes = stack.some((s) => /^@(-\w+-)?keyframes/.test(s.sel));
        if (!inKeyframes) rules.push({ sel: top.sel, start: top.start, end: line });
      }
      buf = ''; bufStartLine = line; i++; continue;
    }
    if (c === ';' && stack.length === 0) { buf = ''; bufStartLine = line; i++; continue; }
    if (buf.trim() === '' && !/\s/.test(c)) bufStartLine = line;
    buf += c; i++;
  }
  return rules;
}
const cssFiles = {
  'app.css': path.join(SRC, 'styles/app.css'),
  'windowing.css': path.join(SRC, 'windowing/components/windowing.css'),
  'clipControls.css': path.join(SRC, 'components/timeline/clipControls.css'),
  'clipControlTuner.css': path.join(SRC, 'components/timeline/clipControlTuner/clipControlTuner.css'),
  'EffectModule.sidechain.css': path.join(SRC, 'components/mixer/EffectModule.sidechain.css'),
  'sandbox.css': path.join(SRC, 'components/sandbox/sandbox.css'),
  'designer.css': path.join(SRC, 'plugin-ui/designer/styles/designer.css'),
  'vendor-xyflow.css': path.join(SRC, 'styles/vendor-xyflow.css'),
};
const cssRules = {};
for (const [k, p] of Object.entries(cssFiles)) cssRules[k] = fs.existsSync(p) ? parseCss(fs.readFileSync(p, 'utf8')) : [];
const appCssLines = lines(cssFiles['app.css']) - (fs.readFileSync(cssFiles['app.css'], 'utf8').endsWith('\n') ? 1 : 0);

// ── class tokens used by a file set ──
const STOP = new Set(['active', 'disabled', 'selected', 'open', 'hidden', 'on', 'off', 'is', 'has', 'dragging', 'focused', 'hover', 'primary', 'danger', 'small', 'large', 'muted', 'empty', 'error', 'loading', 'collapsed', 'expanded', 'visible', 'locked', 'pressed', 'checked']);
function classTokens(files) {
  const toks = new Set();
  for (const f of files) {
    if (!CODE_RE.test(f)) continue;
    const t = fs.readFileSync(f, 'utf8');
    // hyphenated / BEM string tokens anywhere in a string literal
    for (const m of t.matchAll(/(?<![\w.$/#@-])([a-z][a-z0-9]*(?:[-_]{1,2}[a-z0-9]+)+)(?![\w(/])/g)) toks.add(m[1]);
    // any token inside a className attribute / template
    for (const m of t.matchAll(/className\s*=\s*(\{`[^`]*`\}|\{[^}]*\}|"[^"]*"|'[^']*')/g)) {
      for (const w of m[1].matchAll(/[A-Za-z][\w-]*/g)) if (!STOP.has(w[0]) && w[0].length > 2) toks.add(w[0]);
    }
  }
  return toks;
}
function cssMatch(toks) {
  const res = {};
  for (const [name, rules] of Object.entries(cssRules)) {
    let ruleLines = 0; let ruleCount = 0;
    for (const r of rules) {
      const hit = [...toks].some((tk) => r.sel.includes('.' + tk) && new RegExp('\\.' + tk.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '(?![\\w-])').test(r.sel));
      if (hit) { ruleLines += r.end - r.start + 1; ruleCount++; }
    }
    res[name] = { ruleLines, ruleCount };
  }
  return res;
}

// ── per-file facts ──
function fileFacts(files) {
  let loc = 0; let styleObjs = 0; let kitImport = false; let moduleCss = false; let ownsLegacySheet = [];
  for (const f of files) {
    if (!CODE_RE.test(f)) { if (f.endsWith('.css') || f.endsWith('.json')) loc += lines(f); continue; }
    loc += lines(f);
    const t = fs.readFileSync(f, 'utf8');
    styleObjs += (t.match(/style=\{\{/g) || []).length + (t.match(/style=\{[a-zA-Z_][\w.]*\}/g) || []).length * 0;
    if (/from\s+['"][./]+(?:ui-kit|\.\.\/ui-kit)[^'"]*['"]|ui-kit\//.test(t)) kitImport = true;
    if (/\.module\.css['"]/.test(t)) moduleCss = true;
    for (const m of t.matchAll(/import\s+['"]([^'"]+\.css)['"]/g)) if (!m[1].endsWith('.module.css')) ownsLegacySheet.push(path.basename(m[1]));
  }
  return { loc, styleObjs, kitImport, moduleCss, ownsLegacySheet: [...new Set(ownsLegacySheet)] };
}

function gitFacts(files) {
  const rels = files.map((f) => path.relative(REPO, f).replace(/\\/g, '/'));
  if (!rels.length) return { last: '-', phases: 'n/a', phaseCommits: 0 };
  const last = git(['log', '-1', '--format=%h %s', '--', ...rels]).replace(/\|/g, '/').slice(0, 110);
  const subj = git(['log', `${PHASE0_BASE}..HEAD`, '--format=%s', '--', ...rels]).split('\n').filter(Boolean);
  const ph = new Set(); let n = 0;
  for (const s of subj) { const m = s.match(/Phase (\d)([a-c])?/i); if (m) { ph.add('P' + m[1] + (m[2] || '')); n++; } }
  const sorted = [...ph].sort();
  return { last, phases: sorted.length ? sorted.join(',') : 'untouched', phaseCommits: n };
}

function styling(facts, css) {
  // Fewer than 5 matching rule lines is treated as an incidental generic-token hit, not a legacy dependency.
  const legacy = css['app.css'].ruleLines >= 5 || facts.ownsLegacySheet.length > 0 || Object.entries(css).some(([k, v]) => k !== 'app.css' && v.ruleLines >= 5);
  const kit = facts.kitImport || facts.moduleCss;
  let label;
  if (kit && legacy) label = 'mixed (kit + legacy)';
  else if (kit) label = 'kit';
  else if (legacy) label = 'legacy';
  else if (facts.styleObjs > 0) label = 'inline only';
  else label = 'none detected';
  if (facts.styleObjs > 0 && label !== 'inline only') label += ' + inline';
  return label;
}

function row(s) {
  const files = [...new Set(s.files.flatMap(expand))];
  const facts = fileFacts(files);
  const toks = classTokens(files);
  const css = cssMatch(toks);
  const g = gitFacts(files);
  const otherLegacy = Object.entries(css).filter(([k]) => k !== 'app.css').reduce((a, [, v]) => a + v.ruleLines, 0);
  return {
    ...s, files, loc: facts.loc, nfiles: files.length, inline: facts.styleObjs, appCss: css['app.css'].ruleLines,
    appCssRules: css['app.css'].ruleCount, otherLegacy, styling: styling(facts, css), last: g.last, phases: g.phases,
    fileList: files.map((f) => path.relative(SRC, f).replace(/\\/g, '/') + ':' + lines(f)).join(' ; '),
    mainFiles: files.map((f) => path.relative(SRC, f).replace(/\\/g, '/')).slice(0, 4).map((f) => f + ' (' + lines(path.join(SRC, f)) + ')').join(', ') + (files.length > 4 ? ` +${files.length - 4} more` : ''),
  };
}

// ── enumerate registries ──
const registry = fs.readFileSync(path.join(SRC, 'components/devices/deviceRegistry.js'), 'utf8');
const deviceIds = new Set([...registry.matchAll(/^\s{2}(\w+):\s*\{\s*Body:/gm)].map((m) => m[1]));
const catalogSrc = fs.readFileSync(path.join(SRC, 'components/mixer/effectCatalog.js'), 'utf8');
const catalogIds = [...catalogSrc.matchAll(/id: '(\w+)'/g)].map((m) => m[1]);
const missing = AUDIO_EFFECTS.map((e) => e[0]).filter((x) => !catalogIds.includes(x)).concat(catalogIds.filter((x) => !AUDIO_EFFECTS.some((e) => e[0] === x)));
if (missing.length) console.warn('!! manifest/catalog mismatch:', missing);

const rowsOf = {
  surfaces: SURFACES.map(row),
  audio: AUDIO_EFFECTS.map(([id, label, cat, files]) => {
    const r = row({ id: 'fx-' + id, name: label, kind: 'editor', open: '', files });
    const onFrame = deviceIds.has(id);
    return { ...r, cat, pluginId: id, onFrame, open: onFrame
      ? 'FX picker > ' + cat + ' > ' + label + '; shows as a kit device in Devices; Pop out for its window'
      : 'FX picker > ' + cat + ' > ' + label + '; Devices shows title bar + "open editor" body; editor opens in its own window (EffectEditorHost)' };
  }),
  visual: VISUAL_EFFECTS.map(([id, label, kindLabel]) => {
    const base = kindLabel.startsWith('non') ? VISUAL_EFFECT_FILES['non-chainable'] : VISUAL_EFFECT_FILES.chainable;
    const files = [...base, ...(VISUAL_EFFECT_FILES_EXTRA[id] || [])];
    const r = row({ id: 'vfx-' + id, name: label, kind: 'editor', open: 'Edit Grid > cell > Visual FX > + > ' + label, files });
    return { ...r, kindLabel };
  }),
  nodes: FXGRAPH_NODE_TYPES.map(([type, label, how]) => {
    const files = ['fxgraph/graphState.js', 'windowing/panels/FxGraphPanel.tsx', 'windowing/panels/fxgraph/GraphStatePreview.tsx', ...(type === 'envelope' ? ['windowing/panels/fxgraph/EnvelopeEditor.tsx'] : []), ...(type === 'lfo' ? ['windowing/panels/fxgraph/LfoEditor.tsx'] : [])];
    const r = row({ id: 'node-' + type, name: label, kind: 'editor', open: how, files });
    return { ...r, type };
  }),
};

fs.writeFileSync(path.join(OUT, 'inventory-data.json'), JSON.stringify({ rowsOf, appCssLines, deviceIds: [...deviceIds] }, null, 1));

// ── markdown ──
const esc = (s) => String(s).replace(/\|/g, '/').replace(/\n/g, ' ');
const baseline = JSON.parse(fs.readFileSync(path.join(UI, 'scripts/legacy-css-baseline.json'), 'utf8'));
const head = git(['rev-parse', '--short', 'HEAD']);
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
let md = '';
md += `# Xleth UI audit: surface inventory\n\n`;
md += `- Generated: ${new Date().toISOString().slice(0, 10)}; repo HEAD \`${head}\` on \`${branch}\`\n`;
md += `- \`ui/src/styles/app.css\`: **${appCssLines} lines**; \`ui/scripts/legacy-css-baseline.json\` maxLines: **${baseline.maxLines}**\n`;
md += `- Other legacy sheets (in \`@layer legacy\`): ${Object.keys(cssFiles).filter((k) => k !== 'app.css').join(', ')}\n`;
md += `- Rebuild phases are read from commit subjects \`(Phase N…)\` made after \`05c8689\` (Phase 0 step 1). "P8" is the cleanup/deletion phase, so a surface touched ONLY by P8 was cleaned, not rebuilt.\n\n`;
md += `## How the columns were computed\n\n`;
md += `- **LOC**: line count of the main component file(s) (css/json files listed in the surface count too). \`+N more\` = folder surfaces expand to every non-test source file in them; full lists are in \`inventory-data.json\`.\n`;
md += `- **Styling**: \`kit\` = imports from \`ui-kit/\` or a \`*.module.css\`; \`legacy\` = at least 5 lines of \`app.css\` (or another legacy sheet) rules match a class string used in the surface's files, or the files import a legacy sheet; \`mixed\` = both; \`inline only\` = no class match but \`style={{…}}\` present.\n`;
md += `- **app.css lines**: total lines of the rules (selector line to closing brace) whose selector contains a class token (\`.name\`) found in the surface's files (hyphenated/BEM string tokens, plus every word in \`className=\`). Rule count in brackets. This is an estimate: a generic class token shared by several surfaces is counted in each; css-module classes never match.\n`;
md += `- **style={{}}**: literal count of \`style={{\` occurrences in the surface's files.\n`;
md += `- **Last commit**: \`git log -1 --format='%h %s'\` over the surface's files.\n\n`;

function table(rows, cols) {
  let t = '| ' + cols.map((c) => c[0]).join(' | ') + ' |\n|' + cols.map(() => '---').join('|') + '|\n';
  for (const r of rows) t += '| ' + cols.map((c) => esc(c[1](r))).join(' | ') + ' |\n';
  return t + '\n';
}
const common = (open) => [
  ['Surface', (r) => r.name], ['Kind', (r) => r.kind], ['How to open', open || ((r) => r.open)],
  ['Main files (LOC)', (r) => r.mainFiles], ['Styling', (r) => r.styling],
  ['app.css lines [rules]', (r) => `${r.appCss} [${r.appCssRules}]`], ['Other legacy sheet lines', (r) => r.otherLegacy],
  ['style={{}}', (r) => r.inline], ['Last commit touching it', (r) => r.last], ['Rebuild phase', (r) => r.phases],
];
md += `## 1. Surfaces (panels, dock tabs, windows, editors, dialogs, menus, popovers, toasts)\n\n${rowsOf.surfaces.length} rows.\n\n`;
md += table(rowsOf.surfaces, common());
md += `## 2. Audio effects (from \`components/mixer/effectCatalog.js\` EFFECT_CATEGORIES: ${rowsOf.audio.length} insertable stock effects, plus scanned VST3 via the same picker)\n\n`;
md += `"On device frame" = key present in \`components/devices/deviceRegistry.js\` DEVICE_BODIES (${[...deviceIds].join(', ')}). The rest keep the shared device title bar in Devices but open their legacy editor in its own window. \`testgain\` exists in the name maps but is not in the picker.\n\n`;
md += table(rowsOf.audio, [['Effect', (r) => r.name + ' (' + r.pluginId + ')'], ['Category', (r) => r.cat], ['Editor host', (r) => (r.onFrame ? 'device frame (kit body)' : 'own window (legacy panel)')], ['Main files (LOC)', (r) => r.mainFiles], ['Styling', (r) => r.styling], ['app.css lines [rules]', (r) => `${r.appCss} [${r.appCssRules}]`], ['Other legacy sheet lines', (r) => r.otherLegacy], ['style={{}}', (r) => r.inline], ['Last commit touching it', (r) => r.last], ['Rebuild phase', (r) => r.phases]]);
md += `## 3. Visual (video) effects (devices in the Devices tab's Video view, \`components/devices/video/\`)\n\nAll chain effect bodies live in one file (\`VideoChainDevice.jsx\`) and all per-note devices in another (\`NoteDevice.jsx\`), so the counts repeat per row.\n\n`;
md += table(rowsOf.visual, [['Effect', (r) => r.name], ['Kind', (r) => r.kindLabel], ['How to open', (r) => r.open], ['Main files (LOC)', (r) => r.mainFiles], ['Styling', (r) => r.styling], ['app.css lines [rules]', (r) => `${r.appCss} [${r.appCssRules}]`], ['style={{}}', (r) => r.inline], ['Last commit touching it', (r) => r.last], ['Rebuild phase', (r) => r.phases]]);
md += `## 4. FX Graph node types (from \`fxgraph/graphState.js\` constants + \`GraphStatePreview.tsx\` PreviewNodeKind)\n\nAll node types render inside \`GraphStatePreview.tsx\`; counts repeat per row.\n\n`;
md += table(rowsOf.nodes, [['Node type', (r) => r.name + ' (' + r.type + ')'], ['How added', (r) => r.open], ['Main files (LOC)', (r) => r.mainFiles], ['Styling', (r) => r.styling], ['app.css lines [rules]', (r) => `${r.appCss} [${r.appCssRules}]`], ['style={{}}', (r) => r.inline], ['Last commit touching it', (r) => r.last], ['Rebuild phase', (r) => r.phases]]);

// summary
const all = [...rowsOf.surfaces, ...rowsOf.audio, ...rowsOf.visual];
const byStyle = {};
for (const r of rowsOf.surfaces) byStyle[r.styling] = (byStyle[r.styling] || 0) + 1;
md += `## 5. Roll-up\n\n- Surface rows by styling: ${Object.entries(byStyle).map(([k, v]) => `${k}: ${v}`).join('; ')}\n`;
md += `- Audio effects on the device frame: ${rowsOf.audio.filter((r) => r.onFrame).length} of ${rowsOf.audio.length}; own-window legacy editors: ${rowsOf.audio.filter((r) => !r.onFrame).length}\n`;
md += `- Surfaces never touched by any (Phase N) commit since Phase 0: ${rowsOf.surfaces.filter((r) => r.phases === 'untouched').length} of ${rowsOf.surfaces.length}\n`;
fs.writeFileSync(path.join(OUT, 'INVENTORY.md'), md);
console.log('wrote', path.join(OUT, 'INVENTORY.md'), 'rows:', all.length + rowsOf.nodes.length);
