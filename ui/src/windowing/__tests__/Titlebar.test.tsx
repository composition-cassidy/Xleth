import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTitlebarControlTarget } from '../components/Titlebar';

class ElementStub {
  constructor(private readonly buttonAncestor: boolean) {}

  closest(selector: string): ElementStub | null {
    return selector === 'button' && this.buttonAncestor ? this : null;
  }
}

describe('Titlebar double-click control interference', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ignores double-clicks that originate from titlebar buttons', () => {
    vi.stubGlobal('HTMLElement', ElementStub);

    expect(isTitlebarControlTarget(new ElementStub(true) as unknown as EventTarget)).toBe(true);
    expect(isTitlebarControlTarget(new ElementStub(false) as unknown as EventTarget)).toBe(false);
    expect(isTitlebarControlTarget(null)).toBe(false);
  });
});
