// Round 2 step 19: the surfaces the 2026-11-07 run did not reach, and the ones step 19 rebuilt.
//   13b  header column with a track muted and another soloed
//   154  a tall (about 80px) lane with a clip selected: fades and handles
//   160/161  the snapshot cue editor, then with a line-sweep transition and the easing editor open
//   157/158  the Vibrato and Scratch windows
//   139  the Quantize dialog
//   153  a macro automation lane (needs FX Graph's Add menu to add a Macro node; reported if it cannot)
// Run after p20 on a fresh driver:  node send.mjs phases/p19-timeline-polish.mjs
import { shot, auditInPage } from '../shotlib.mjs';

export default async ({ page, sleep }) => {
  const out = [];
  const ROOT = '[data-testid="xleth-docked-window-layer"]';
  const esc = async (n = 3) => { for (let i = 0; i < n; i++) { await page.keyboard.press('Escape'); await sleep(150); } };
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await esc(); } };
  const audit = async (label, scopeSel) => {
    const m = await page.evaluate(auditInPage, { scopeSel, minContrast: 4.5, minFontPx: 10 });
    if (m.error) { out.push(`${label}: ${m.error}`); return; }
    out.push(`${label}: text ${m.text.total}, <4.5:1 ${m.text.lowContrast}, <10px ${m.text.small}, fs ${m.distinctFontSizes}, caps ${m.letterSpacedUppercaseCount}, style= ${m.styleAttrs}`);
  };
  const around = async (sel, pad = 8) => { const b = await page.locator(sel).last().boundingBox(); return { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + 2 * pad, height: b.height + 2 * pad }; };
  const laneH = () => page.evaluate(() => [...document.querySelectorAll('.track-header')].map((e) => Math.round(e.getBoundingClientRect().height)).filter((h) => h > 0).sort((a, b) => a - b)[0]);

  await esc();
  const sel = page.locator('[data-detail-tab][aria-selected="true"]').first();
  if (await sel.count()) { await sel.click(); await sleep(700); }
  await page.mouse.move(1000, 560);

  // 13b: header state at rest in the muted and soloed case
  await step('13b', async () => {
    await audit('headers at rest', '.timeline-header-column');
    await page.locator('button[aria-label="Mute KICK"]').first().click(); await sleep(400);
    await page.locator('button[aria-label="Solo SNARE"]').first().click(); await sleep(400);
    await audit('headers, KICK muted and SNARE soloed', '.timeline-header-column');
    out.push(await shot(page, '13b-timeline-headers-muted-solo', { surface: 'timeline-headers', scope: '.timeline-header-column', clip: { x: 258, y: 410, width: 340, height: 440 } }));
    await page.locator('button[aria-label="Mute KICK"]').first().click(); await sleep(300);
    await page.locator('button[aria-label="Solo SNARE"]').first().click(); await sleep(300);
  });

  // 160/161: the cue editor (add a cue at the playhead, open it, switch it on)
  await step('cue', async () => {
    await page.locator('[data-testid="snapshot-cue-lane-header"] button').click(); await sleep(900);
    await audit('cue lane at rest', '[data-testid="snapshot-cue-lane"]');
    await page.locator('.vmt-cue-marker').first().click(); await sleep(600);
    out.push(await shot(page, '160-timeline-cue-editor', { surface: 'timeline-cue-editor', scope: '.vmt-cue-editor', live: true, clip: await around('.vmt-cue-editor') }));
    await audit('cue editor', '.vmt-cue-editor');
    await page.getByRole('button', { name: 'Transition', exact: true }).click(); await sleep(600);
    await page.locator('[aria-label^="Animation type for cue"]').click(); await sleep(400);
    await page.locator('[role="option"][data-value="lineSweep"]').click(); await sleep(600);
    await page.locator('.vmt-easing-summary').click(); await sleep(500);
    out.push(await shot(page, '161-timeline-cue-editor-line-sweep-easing', { surface: 'timeline-cue-editor', scope: '.vmt-cue-editor', live: true, clip: await around('.vmt-cue-editor', 10) }));
    await audit('cue editor, line sweep and easing', '.vmt-cue-editor');
    await audit('loop region bar', '.loop-region-overlay');
    await page.locator('.vmt-close-cue-editor').click(); await sleep(300);
  });

  // 139: the Quantize dialog on a selected clip
  await step('139', async () => {
    await page.mouse.click(1250, 597); await sleep(600);
    await page.locator('button[aria-label="Quantize"]').click(); await sleep(800);
    out.push(await shot(page, '139-quantize-dialog', { surface: 'dialog-quantize', scope: '[role="dialog"]', live: true }));
    await audit('quantize dialog', '[role="dialog"]');
    await esc();
  });

  // 157/158: the clip FX editors (the clip stays selected)
  for (const [idx, name, tid] of [[0, '157-clip-fx-editor-vibrato', 'clip-vibrato-editor'], [1, '158-clip-fx-editor-scratch', 'clip-scratch-editor']]) {
    await step(name, async () => {
      await page.locator('button[data-hint^="Open the"]').nth(idx).click(); await sleep(900);
      const sc = `[data-testid="${tid}"]`;
      out.push(await shot(page, name, { surface: 'clip-fx-editor', scope: sc, live: true, clip: await around(sc, 6) }));
      await audit(name, sc);
      await page.keyboard.press('Escape'); await sleep(300);
      out.push(`${name}: windows left open after Escape: ${await page.locator('[data-testid="clip-fx-editor-host"] [role="dialog"]').count()}`);
    });
  }

  // 154: a tall lane with the clip selected. Alt+wheel over the canvas, toward 80px.
  await step('154', async () => {
    await page.mouse.move(1000, 560);
    for (let i = 0; i < 30; i++) {
      const h = await laneH();
      if (h >= 78 && h <= 90) break;
      await page.keyboard.down('Alt'); await page.mouse.wheel(0, h < 78 ? -40 : 40); await page.keyboard.up('Alt'); await sleep(200);
    }
    out.push('lane height: ' + await laneH());
    await audit('headers at a tall lane', '.timeline-header-column');
    out.push(await shot(page, '154-timeline-lane-80-fades-handles', { surface: 'panel-timeline', scope: ROOT, note: 'Alt+wheel to a tall lane, a clip selected' }));
  });

  // 153: a macro automation lane
  await step('153', async () => {
    const DOCK = '[data-testid="xleth-detail-dock"]';
    const open = page.locator('[data-detail-tab][aria-selected="true"]').first();
    if (!(await open.count())) {
      await page.locator('[data-detail-tab="mixer"]').first().click(); await sleep(1200);
    }
    await page.locator('[data-detail-tab="mixer"]').first().click(); await sleep(1000);
    await page.locator(`${DOCK} [class*="strip"]`).filter({ hasText: /^2\s*ch1/ }).first().click({ position: { x: 30, y: 14 } }); await sleep(500);
    await page.locator('[data-detail-tab="fxGraph"]').first().click(); await sleep(1500);
    const c = await page.evaluate((d) => { const r = document.querySelector(d).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, DOCK);
    await page.mouse.click(c.x + c.w * 0.3, c.y + c.h * 0.4, { button: 'right' }); await sleep(500);
    await page.getByRole('menuitem', { name: 'Macro', exact: true }).first().click({ timeout: 4000 }); await sleep(1000);
    const node = page.getByText(/^Macro \d/).first();
    if (!(await node.count())) { out.push('153: the Add menu did not add a Macro node in this build; the macro lane was not photographed'); await esc(); return; }
    const b = await node.boundingBox();
    await page.mouse.click(b.x + 10, b.y + 4, { button: 'right' }); await sleep(600);
    await page.getByRole('menuitem', { name: 'Create Automation Clip' }).click(); await sleep(900);
    await page.locator('[data-detail-tab][aria-selected="true"]').first().click(); await sleep(900);
    await audit('macro lane layer', '.macro-automation-lanes-layer');
    out.push(await shot(page, '153-timeline-macro-automation-lanes', { surface: 'panel-timeline', scope: ROOT, note: 'Macro 1 on ch1, Create Automation Clip' }));
  });
  return out.join('\n');
};
