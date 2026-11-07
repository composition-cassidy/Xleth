// At 200 % UI scale a 1366 px window is 683 CSS px wide. The top bar and the detail dock tab
// strip have to be laid out for that width (verified on renders with
// `npm run shots -- --scale 200 --viewport 1366x768`); these pin the rules that do it.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('layout at a narrow CSS viewport (high UI scale)', () => {
  it('doubles the top chrome height below 1100 CSS px, so the legacy grid reserves two rows', () => {
    const css = read('ui-kit/tokens.css');
    expect(css).toMatch(/@media \(max-width: 1100px\)\s*\{\s*:root\s*\{\s*--shell-topbar-h:\s*72px;/);
  });

  it('lays the top bar out as two rows: menus, panel toggles and window controls over the whole transport', () => {
    const css = read('components/TitleBar.module.css');
    const block = css.slice(css.indexOf('@media (max-width: 1100px)'));
    expect(block).toMatch(/"left dock controls"\s*"center center center"/);
    expect(block).toMatch(/\.right\s*\{\s*display:\s*contents;/);
    // Panel toggles scroll rather than shrink under the 24 px hit-area floor.
    expect(block).toMatch(/\.dock\s*>\s*button\s*\{[^}]*flex:\s*0 0 auto;[^}]*min-width:\s*var\(--hit-min\)/);
  });

  it('the dock class is on the launcher strip', () => {
    expect(read('components/TitleBar.jsx')).toMatch(/titlebar-dock \$\{styles\.dock\}/);
  });

  it('drops the detail dock tab glyphs (not the names) below 800 CSS px so the tabs fit', () => {
    const css = read('windowing/components/DetailDock.module.css');
    expect(css).toMatch(/@media \(max-width: 800px\)\s*\{\s*\.tabButton > svg\s*\{\s*display:\s*none;/);
  });
});
