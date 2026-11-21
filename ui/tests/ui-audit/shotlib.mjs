// shot(): screenshot + per-shot metrics. Read-only: only reads computed styles from the DOM.
import fs from 'node:fs';
import path from 'node:path';
import { SHOTS, OUT, sleep } from './lib.mjs';

/** Runs in the page. Adapted from tests/ui-render/shots.mjs auditTextInPage, scoped to a subtree. */
export function auditInPage({ scopeSel, minContrast, minFontPx }) {
  const roots = scopeSel ? [...document.querySelectorAll(scopeSel)].filter((e) => e.checkVisibility?.()) : [document.body];
  if (!roots.length) return { error: 'scope not found: ' + scopeSel };
  const cv = document.createElement('canvas'); cv.width = 1; cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const parse = (s) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = s; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (fg, bg) => { const a = fg[3]; return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1]; };
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const describe = (el) => { const parts = []; for (let n = el, i = 0; n && n.nodeType === 1 && i < 3; n = n.parentElement, i += 1) { const cls = (typeof n.className === 'string' ? n.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.'); parts.unshift(n.tagName.toLowerCase() + (cls ? '.' + cls : '')); } return parts.join(' > '); };
  const backgroundOf = (el) => { const layers = []; let uncertain = false; for (let n = el; n; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.backgroundImage && cs.backgroundImage !== 'none') uncertain = true; const c = parse(cs.backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; } let acc = [255, 255, 255, 1]; for (let i = layers.length - 1; i >= 0; i -= 1) acc = over(layers[i], acc); return { bg: acc, uncertain }; };
  const opacityOf = (el) => { let o = 1; for (let n = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity) || 0; return o; };

  const text = { total: 0, lowContrast: 0, small: 0, uncertainBackground: 0, disabledExempt: 0, entries: [] };
  const fontSizes = new Set(); const borderColors = new Set(); const spaced = [];
  let styleAttrs = 0; let elementCount = 0; let canvasCount = 0;
  const range = document.createRange();
  const seen = new Set();
  for (const root of roots) {
    const all = [root, ...root.querySelectorAll('*')];
    for (const el of all) {
      if (seen.has(el)) continue; seen.add(el);
      elementCount += 1;
      if (el.tagName === 'CANVAS') canvasCount += 1;
      if (el.hasAttribute('style')) styleAttrs += 1;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        if (cs['border' + side + 'Style'] !== 'none' && parseFloat(cs['border' + side + 'Width']) > 0) borderColors.add(cs['border' + side + 'Color']);
      }
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const t = node.nodeValue.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const el = node.parentElement;
      if (!el || /^(SCRIPT|STYLE|NOSCRIPT|OPTION)$/.test(el.tagName)) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
      const cs = getComputedStyle(el);
      const fontPx = parseFloat(cs.fontSize);
      fontSizes.add(cs.fontSize);
      const { bg, uncertain } = backgroundOf(el);
      const fgRaw = parse(cs.color); fgRaw[3] *= opacityOf(el);
      const fg = over(fgRaw, bg); const cr = ratio(fg, bg);
      text.total += 1;
      const reasons = [];
      const disabled = !!el.closest('[disabled], [aria-disabled="true"]');
      if (cr < minContrast && disabled) text.disabledExempt += 1;
      else if (cr < minContrast) { reasons.push('contrast'); text.lowContrast += 1; }
      if (fontPx < minFontPx) { reasons.push('size'); text.small += 1; }
      if (uncertain) text.uncertainBackground += 1;
      if (reasons.length && text.entries.length < 40) text.entries.push({ text: t.slice(0, 50), where: describe(el), fontPx: Math.round(fontPx * 100) / 100, fg: hex(fg), bg: hex(bg), ratio: Math.round(cr * 100) / 100, backgroundUncertain: uncertain, reasons });
      // letter-spaced uppercase
      const ls = parseFloat(cs.letterSpacing);
      const letters = t.replace(/[^A-Za-z]/g, '');
      const upper = cs.textTransform === 'uppercase' || (letters.length >= 2 && letters === letters.toUpperCase());
      if (ls > 0 && upper && spaced.length < 40) spaced.push({ text: t.slice(0, 40), letterSpacing: cs.letterSpacing, via: cs.textTransform === 'uppercase' ? 'text-transform' : 'literal caps', where: describe(el) });
    }
  }
  return {
    scope: scopeSel || 'body', elementCount, canvasCount, styleAttrs,
    distinctFontSizes: fontSizes.size, fontSizeList: [...fontSizes].sort((a, b) => parseFloat(a) - parseFloat(b)),
    distinctBorderColors: borderColors.size,
    letterSpacedUppercase: spaced.length > 0, letterSpacedUppercaseCount: spaced.length, letterSpacedSamples: spaced.slice(0, 6),
    text,
  };
}

export const metrics = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(OUT, 'metrics.partial.json'), 'utf8')); } catch { return []; }
})();

/** Wait until every canvas stops changing (center pixel sample, one 300 ms step). */
export async function settle(page, timeout = 3500) {
  const start = Date.now(); let prev = '';
  while (Date.now() - start < timeout) {
    const h = await page.evaluate(() => [...document.querySelectorAll('canvas')].filter((c) => c.checkVisibility?.()).map((c) => {
      try { const x = c.getContext('2d'); if (!x) return ''; const d = x.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data; return `${c.width}x${c.height}:${d[0]},${d[1]},${d[2]}`; } catch { return ''; }
    }).join('|')).catch(() => '');
    if (h === prev) return; prev = h; await sleep(300);
  }
}

/**
 * opts: { surface (inventory id), files, scope (CSS selector for metrics), clip ({x,y,width,height}), note, live (skip settle/freeze) }
 */
export async function shot(page, name, opts = {}) {
  const file = path.join(SHOTS, name + '.png');
  if (!opts.live) await settle(page);
  const png = await page.screenshot({ path: file, ...(opts.clip ? { clip: opts.clip } : {}) });
  const m = await page.evaluate(auditInPage, { scopeSel: opts.scope || null, minContrast: 4.5, minFontPx: 10 }).catch((e) => ({ error: String(e) }));
  const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
  const rec = { shot: name + '.png', surface: opts.surface || null, files: opts.files || [], viewport: size, note: opts.note || null, bytes: png.length, ...m };
  const idx = metrics.findIndex((x) => x.shot === rec.shot);
  if (idx >= 0) metrics[idx] = rec; else metrics.push(rec);
  fs.writeFileSync(path.join(OUT, 'metrics.partial.json'), JSON.stringify(metrics, null, 1));
  return `${name}: ${m.error || `text ${m.text.total}, <4.5:1 ${m.text.lowContrast}, <10px ${m.text.small}, style= ${m.styleAttrs}, fs ${m.distinctFontSizes}, borders ${m.distinctBorderColors}, caps-spaced ${m.letterSpacedUppercaseCount}`}`;
}
