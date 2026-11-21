// Sampler at the DEFAULT dock height (the shell's clamp, not the enlarged dock p30 leaves behind): Main, Playback, and the
// Modulation view's four sources (Env, LFO, Velocity, Note). Run before p30. Shot names continue the 2026-11-07 set
// (31 = Main at the default dock; 36..39 = the modulation sources, which were a pull-out tray until round 2 step 11).
import { shot } from '../shotlib.mjs';

export default async ({ page, sleep }) => {
  const out = [];
  const DOCK = '[data-testid="xleth-detail-dock"]';
  const step = async (label, fn) => { try { await fn(); } catch (e) { out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`); await page.keyboard.press('Escape'); } };
  await page.keyboard.press('Escape'); await sleep(200);
  const prTab = page.locator('[data-detail-tab="pianoRoll"]').first();
  if ((await prTab.getAttribute('aria-selected')) !== 'true') { await prTab.click(); await sleep(900); }
  await page.getByText('Pattern 8', { exact: false }).first().dblclick(); await sleep(1400);
  await page.locator(`${DOCK} button[title^="Sampler settings" i], ${DOCK} button[aria-label^="Sampler settings" i]`).first().click({ timeout: 8000 }); await sleep(1600);
  await page.mouse.move(1000, 300); await sleep(300);

  const view = async (name) => {
    await page.locator('[role="tablist"][aria-label="Sampler views"] [role="tab"]').filter({ hasText: new RegExp(`^${name}$`) }).first().click();
    await sleep(800); await page.mouse.move(1000, 300); await sleep(200);
  };
  const source = async (label) => {
    await page.locator('[role="tablist"][aria-label="Modulation sources"] [role="tab"]').filter({ hasText: new RegExp(`^${label}\\d*$`) }).first().click();
    await sleep(600); await page.mouse.move(1000, 300); await sleep(200);
  };
  const overflow = () => page.evaluate(() => {
    const root = document.querySelector('[data-sampler-view]');
    return [...(root?.querySelectorAll('*') || [])].filter((e) => {
      const cs = getComputedStyle(e);
      return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 1;
    }).length;
  });

  await step('31', async () => {
    out.push(await shot(page, '31-sampler-main-default-dock', { surface: 'dock-sampler', scope: DOCK, note: 'default dock height, nothing scrolled' }));
    out.push(`main vertical scrollers: ${await overflow()}`);
  });
  await step('32', async () => {
    await view('Playback');
    out.push(await shot(page, '32-sampler-playback-default-dock', { surface: 'dock-sampler', scope: DOCK, note: 'default dock height' }));
    out.push(`playback vertical scrollers: ${await overflow()}`);
  });
  await step('36', async () => {
    await view('Modulation');
    await source('Env 1');
    out.push(await shot(page, '36-sampler-mod-env', { surface: 'sampler-modulation', scope: DOCK, note: 'Modulation view, Env 1 (amp envelope)' }));
    out.push(`modulation vertical scrollers: ${await overflow()}`);
  });
  await step('37', async () => {
    const hasLfo = await page.locator('[role="tablist"][aria-label="Modulation sources"] [role="tab"]').filter({ hasText: /^LFO 1/ }).count();
    if (!hasLfo) { await page.locator('button[aria-label="Add an LFO"]').click(); await sleep(800); out.push('added LFO 1 (project copy only)'); }
    await source('LFO 1');
    out.push(await shot(page, '37-sampler-mod-lfo', { surface: 'sampler-modulation', scope: DOCK, note: 'LFO 1 editor, drawable shape' }));
  });
  await step('38', async () => {
    await source('Velocity');
    out.push(await shot(page, '38-sampler-mod-velo', { surface: 'sampler-modulation', scope: DOCK, note: 'Velocity response' }));
  });
  await step('39', async () => {
    await source('Note');
    out.push(await shot(page, '39-sampler-mod-note', { surface: 'sampler-modulation', scope: DOCK, note: 'Note response' }));
  });
  await view('Main');
  return out.join('\n');
};
