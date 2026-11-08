// Piano Roll: a dense pattern (Pattern 8, 32 notes), selection, zoomed, empty pattern. Dock enlarged by dragging its splitter.
import { shot } from '../shotlib.mjs';

export default async ({ page, sleep }) => {
  const out = [];
  const DOCK = '[data-testid="xleth-detail-dock"]';
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await page.keyboard.press('Escape'); } };
  await page.keyboard.up('Control');
  await page.keyboard.press('Escape'); await sleep(200);
  const tab = page.locator('[data-detail-tab="pianoRoll"]').first();
  for (let i = 0; i < 3 && (await tab.getAttribute('aria-selected')) !== 'true'; i++) { await tab.click(); await sleep(900); }
  const h = await page.evaluate((s) => document.querySelector(s).getBoundingClientRect().height, DOCK);
  out.push('dock height ' + h);
  if (h < 450) {
    const r = await page.locator('[data-testid="xleth-dock-region-resizer-bottom"]').first().boundingBox({ timeout: 5000 });
    await page.mouse.move(r.x + 600, r.y + 4); await page.mouse.down(); await page.mouse.move(r.x + 600, 330, { steps: 12 }); await page.mouse.up(); await sleep(900);
  }
  await step('open', async () => { await page.getByText('Pattern 8', { exact: false }).first().dblclick(); await sleep(1200); });
  await page.mouse.move(1000, 300); await sleep(500);

  await step('20', async () => out.push(await shot(page, '20-pianoroll-many-notes-velocity-labels-scale', { surface: 'dock-pianoroll', scope: DOCK, note: 'Pattern 8: 32 notes, melodic, scale highlight on' })));

  // Round 2 step 12: the Sample view (notes print their transposition from the slot root).
  await step('24', async () => {
    const seg = page.locator(`${DOCK} [role="radio"]`, { hasText: 'Sample' }).first();
    await seg.click(); await sleep(500); await page.mouse.move(1000, 300); await sleep(200);
    out.push(await shot(page, '24-pianoroll-sample-view', { surface: 'dock-pianoroll', scope: DOCK, note: 'Pattern 8 in Sample view: semitones from the sample root' }));
    await page.locator(`${DOCK} [role="radio"]`, { hasText: 'Pitch' }).first().click(); await sleep(300);
  });

  await step('21', async () => {
    await page.locator('button[title^="Select"], button[aria-label^="Select"]').last().click().catch(() => {});
    await page.mouse.move(335, 548); await page.mouse.down(); await page.mouse.move(1750, 905, { steps: 15 }); await page.mouse.up(); await sleep(700);
    out.push(await shot(page, '21-pianoroll-selection-tools', { surface: 'dock-pianoroll', scope: DOCK, note: 'Select tool, rubber-band over the visible notes' }));
    await page.mouse.click(1100, 600); await sleep(200);
  });

  await step('22', async () => {
    const zi = page.locator(`${DOCK} button[aria-label="Zoom in"], ${DOCK} button[title="Zoom in"]`).first();
    for (let i = 0; i < 3; i++) { await zi.click(); await sleep(250); }
    await sleep(600);
    out.push(await shot(page, '22-pianoroll-zoomed-in', { surface: 'dock-pianoroll', scope: DOCK }));
    const zo = page.locator(`${DOCK} button[aria-label="Zoom out"], ${DOCK} button[title="Zoom out"]`).first();
    for (let i = 0; i < 3; i++) { await zo.click(); await sleep(250); }
  });

  await step('23', async () => {
    const sels = await page.locator(`${DOCK} select`).all();
    let done = false;
    for (const s of sels) {
      const opts = await s.locator('option').allTextContents();
      if (opts.some((o) => /New Pattern/.test(o))) { await s.selectOption({ label: opts.find((o) => /New Pattern/.test(o)) }); done = true; break; }
    }
    out.push('new pattern via select: ' + done);
    await sleep(1200); await page.mouse.move(1000, 300);
    out.push(await shot(page, '23-pianoroll-empty-pattern', { surface: 'dock-pianoroll', scope: DOCK, note: 'a freshly created pattern (project copy)' }));
  });
  return out.join('\n');
};
