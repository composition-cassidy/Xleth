// Visual FX: every video effect added to the pitch track through the Devices tab's
// Video view (round 2 step 17: video effects are devices; nothing is left in the
// Inspector). Select the track, open its picture with the Inspector's "Video
// effects" button, then add each per-note device and each chain effect through
// "Drop video effects here". p76 shoots the chain.
export default async ({ page, sleep }) => {
  const out = [];
  await page.keyboard.up('Control'); await page.keyboard.press('Escape'); await sleep(200);
  await page.locator('.track-header', { hasText: 'pitch' }).last().click({ position: { x: 60, y: 14 } }).catch(() => {}); await sleep(700);
  try {
    await page.locator('[data-testid="xleth-inspector-video-fx"]').first().click({ timeout: 4000 }); await sleep(900);
    out.push('opened the Video view from the Inspector');
  } catch (e) {
    out.push(`Video effects button: FAIL ${String(e.message).split('\n')[0]}`);
    await page.locator('[data-chain-view="video"]').first().click().catch(() => {}); await sleep(700);
  }

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const add = async (group, label) => {
    try {
      await page.getByRole('button', { name: 'Drop video effects here' }).first().click({ timeout: 4000 }); await sleep(300);
      await page.getByRole('menuitem', { name: new RegExp('^' + esc(group)) }).first().click({ timeout: 3000 }); await sleep(250);
      await page.locator('[role="menuitem"], [role="menuitemcheckbox"]', { hasText: new RegExp('^\\s*' + esc(label) + '\\s*$') }).last().click({ timeout: 3000 });
      await sleep(700);
      out.push('added ' + label);
    } catch (e) {
      out.push(`${label}: FAIL ${String(e.message).split('\n')[0]}`);
      await page.keyboard.press('Escape'); await sleep(200);
    }
  };
  for (const label of ['Ping-pong loop', 'Zoom/pan/rot', 'Bounce', 'Note fade', 'Slide note effect']) await add('Per note', label);
  for (const label of ['Desaturation', 'Tint', 'Brightness and contrast', 'TV simulator', 'Zoom/pan/rot (chain)', 'Chroma key', 'Outline', 'Drop shadow', 'Visual echo']) await add('Chain', label);
  await page.mouse.move(900, 900); await sleep(400);
  return out.join('\n');
};
