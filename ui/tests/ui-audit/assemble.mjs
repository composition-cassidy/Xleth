// Builds the final metrics.json and appends the shot-coverage section to INVENTORY.md.
//   node tests/ui-audit/inventory.mjs && node tests/ui-audit/assemble.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const SHOTS = path.join(OUT, 'shots');
const inv = JSON.parse(fs.readFileSync(path.join(OUT, 'inventory-data.json'), 'utf8'));
const have = new Set(fs.readdirSync(SHOTS).filter((f) => f.endsWith('.png')));
const RENAME = { '50-mixer-routing-sidechain': '94-mixer-routing-sidechain', '51-mixer-strip-selected': '95-mixer-strip-selected', '52-mixer-meters-playing': '96-mixer-meters-playing', '53-compressor-sidechain-external-kick': '97-compressor-sidechain-external-kick' };
const raw = JSON.parse(fs.readFileSync(path.join(OUT, 'metrics.partial.json'), 'utf8'));

const byId = new Map();
for (const r of inv.rowsOf.surfaces) byId.set(r.id, r);
for (const r of inv.rowsOf.audio) byId.set(r.id, r);
const filesOf = (id) => (byId.get(id)?.fileList || '').split(' ; ').filter(Boolean).slice(0, 12);

const shots = [];
for (const m of raw) {
  const base = m.shot.replace(/\.png$/, '');
  const name = RENAME[base] || base;
  if (!have.has(name + '.png')) continue;
  const rec = { ...m, shot: name + '.png' };
  // popped-out effect windows: the effect's own files plus the floating-device host
  const pm = name.match(/^\d+-device-popout-(\w+)$/);
  if (pm) rec.surface = 'fx-' + pm[1];
  rec.components = [...new Set([...filesOf(rec.surface), ...(pm ? filesOf('device-floating').slice(0, 2) : [])])];
  delete rec.files;
  shots.push(rec);
}
shots.sort((a, b) => a.shot.localeCompare(b.shot, undefined, { numeric: true }));
const totals = shots.reduce((t, s) => { if (s.text) { t.text += s.text.total; t.low += s.text.lowContrast; t.small += s.text.small; } return t; }, { text: 0, low: 0, small: 0 });
fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify({
  generated: new Date().toISOString(),
  method: {
    textAudit: 'Phase 0 logic (tests/ui-render/shots.mjs auditTextInPage) scoped to the surface subtree: visible text nodes with a computed WCAG ratio < 4.5 (disabled controls exempt and counted separately) or font size < 10 px. Backgrounds with images/gradients are flagged backgroundUncertain.',
    scope: 'scope = the CSS selector the metrics were computed over (null/body = whole window). Canvas pixels are not text and are not audited.',
    styleAttrs: 'elements carrying a style attribute in the subtree',
    distinct: 'distinctFontSizes / distinctBorderColors count computed values over visible text nodes / all elements with a drawn border',
    letterSpacedUppercase: 'a visible text node with computed letter-spacing > 0 that is uppercase by text-transform or typed in capitals',
  },
  theme: 'xleth-default (Default, dark neutral ramp), UI scale 100 %',
  totals: { shots: shots.length, textNodes: totals.text, below4_5: totals.low, below10px: totals.small },
  shots,
}, null, 1));

// ── coverage section for INVENTORY.md ──
const cover = new Map();
for (const s of shots) { const k = s.surface; if (!k) continue; (cover.get(k) || cover.set(k, []).get(k)).push(s.shot.replace('.png', '')); }
// Surfaces that are visible inside other shots (no dedicated shot).
const ALSO = {
  topbar: ['01-shell-default-dock-collapsed'], detaildock: ['02-shell-dock-devices', '06-shell-dock-fxgraph'],
  'timeline-pattern-list': ['10-timeline-default-clips-and-patterns'], 'timeline-cue-lane': ['10-timeline-default-clips-and-patterns'],
  'timeline-loop-bar': ['10-timeline-default-clips-and-patterns'],
  'dlg-settings': ['120-settings-project-general'], 'menu-settings': ['120-settings-project-general'],
  'plugin-ui-runtime': ['51-device-popout-overdone', '52-device-popout-transientproc', '53-device-popout-resonancesuppressor', '55-device-popout-distortion', '43-device-popout-compressor', '48-device-popout-limiter'],
  'preview-zpr': ['85-preview-visualfx-01of12'], 'preview-note-fade': ['85-preview-visualfx-01of12'],
};
for (const [k, v] of Object.entries(ALSO)) { const have2 = cover.get(k) || []; cover.set(k, [...new Set([...have2, ...v.filter((n) => have.has(n + '.png'))])]); }
const rows = [...inv.rowsOf.surfaces, ...inv.rowsOf.audio];
let md = '\n## 6. Screenshot coverage (which shot shows which surface)\n\nSurface ids are the same as in `surfaces.mjs`. "-" means no dedicated shot; the reason is in `MANUAL-SHOTS.md` or the report.\n\n| Surface | Shots |\n|---|---|\n';
for (const r of rows) {
  const s = cover.get(r.id) || [];
  md += `| ${r.name} | ${s.length ? s.slice(0, 6).join(', ') + (s.length > 6 ? ` (+${s.length - 6})` : '') + (ALSO[r.id] && !(s.length && false) ? ' (visible inside, no dedicated shot)' : '') : '- (see MANUAL-SHOTS.md)'} |\n`;
}
const vis = shots.filter((s) => /visualfx/.test(s.shot)).map((s) => s.shot.replace('.png', ''));
md += `\nVisual (video) effects: all 12 were added to one pattern track and are visible across \`${vis[0]}\` to \`${vis[vis.length - 1]}\` (the Inspector column scrolled top to bottom). They share one parameter-editor file, so there is no per-effect shot.\n`;
md += `FX Graph node types: trackInput / trackOutput / effect in \`70-fxgraph-ch1-initial\`; macro, LFO, envelope and sidechainInput added in \`71-fxgraph-several-nodes\`; the add menu in \`72-fxgraph-canvas-add-menu\`.\n`;
const invPath = path.join(OUT, 'INVENTORY.md');
let cur = fs.readFileSync(invPath, 'utf8');
cur = cur.replace(/\n## 6\. Screenshot coverage[\s\S]*$/, '');
fs.writeFileSync(invPath, cur + md);
const missing = rows.filter((r) => !(cover.get(r.id) || []).length).map((r) => r.id);
console.log(JSON.stringify({ shots: shots.length, uncoveredSurfaces: missing }, null, 1));
