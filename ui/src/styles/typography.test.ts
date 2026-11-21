import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { uiCanvasFont } from './typography';

const UI_FONT_STACK = '"Barlow", "Inter", "Noto Sans", "Segoe UI", system-ui, sans-serif';
const BARLOW_FONT_FILES = [
  'Barlow-Light.ttf',
  'Barlow-Regular.ttf',
  'Barlow-Medium.ttf',
  'Barlow-SemiBold.ttf',
  'Barlow-Bold.ttf',
];

describe('global UI typography', () => {
  it('defines the centralized UI font stack in app.css', () => {
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

    expect(css).toContain(`--xleth-global-font-family: ${UI_FONT_STACK};`);
    expect(css).toContain('font-family: var(--xleth-global-font-family);');
    for (const fontFile of BARLOW_FONT_FILES) {
      expect(css).toContain(`url("../../assets/fonts/Barlow/${fontFile}")`);
      expect(existsSync(new URL(`../../assets/fonts/Barlow/${fontFile}`, import.meta.url))).toBe(true);
    }
    expect(css).not.toMatch(/neuzeit/i);
  });

  it('uses the same stack for canvas text when no DOM is available', () => {
    expect(uiCanvasFont('600 11px')).toBe(`600 11px ${UI_FONT_STACK}`);
  });
});
