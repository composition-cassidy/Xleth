import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { uiCanvasFont } from './typography';

const UI_FONT_STACK = '"Neuzeit Grotesk", "Inter", "Noto Sans", "Segoe UI", system-ui, sans-serif';
const NEUZEIT_FONT_FILES = [
  'Neuzeit-Grotesk-Light.otf',
  'Neuzeit-Grotesk.otf',
  'Neuzeit-Grotesk-Bold.otf',
];

describe('global UI typography', () => {
  it('defines the centralized UI font stack in app.css', () => {
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

    expect(css).toContain(`--xleth-global-font-family: ${UI_FONT_STACK};`);
    expect(css).toContain('font-family: var(--xleth-global-font-family);');
    for (const fontFile of NEUZEIT_FONT_FILES) {
      expect(css).toContain(`url("../../../${fontFile}")`);
    }
  });

  it('uses the same stack for canvas text when no DOM is available', () => {
    expect(uiCanvasFont('600 11px')).toBe(`600 11px ${UI_FONT_STACK}`);
  });
});
