import { describe, expect, it } from 'vitest';

const { encodeBmp, renderGenerated, unpremultiply } = await import('./still-media.js');

const alphaAt = ({ w, px }, x, y) => px[(y * w + x) * 4 + 3];

// BGRA of pixel (x, y) in a renderGenerated result, as [r, g, b].
const rgbAt = ({ w, px }, x, y) => { const o = (y * w + x) * 4; return [px[o + 2], px[o + 1], px[o]]; };

describe('still-media', () => {
  it('fills a solid colour', () => {
    const img = renderGenerated({ kind: 'solid', color: '#12ab34' });
    expect(img.name).toBe('Solid 12AB34');
    expect(rgbAt(img, 0, 0)).toEqual([0x12, 0xab, 0x34]);
    expect(rgbAt(img, img.w - 1, img.h - 1)).toEqual([0x12, 0xab, 0x34]);
  });

  it('runs a gradient end to end in its direction', () => {
    const h = renderGenerated({ kind: 'gradient', from: '#ff0000', to: '#0000ff', direction: 'horizontal' });
    expect(rgbAt(h, 0, 5)).toEqual([255, 0, 0]);
    expect(rgbAt(h, h.w - 1, 5)).toEqual([0, 0, 255]);
    const v = renderGenerated({ kind: 'gradient', from: '#000000', to: '#ffffff', direction: 'vertical' });
    expect(rgbAt(v, 5, 0)).toEqual([0, 0, 0]);
    expect(rgbAt(v, 5, v.h - 1)).toEqual([255, 255, 255]);
    const r = renderGenerated({ kind: 'gradient', from: '#ffffff', to: '#000000', direction: 'radial' });
    expect(rgbAt(r, r.w >> 1, r.h >> 1)[0]).toBeGreaterThan(250);
    expect(rgbAt(r, 0, r.h >> 1)).toEqual([0, 0, 0]);
  });

  it('carries opacity: #rrggbbaa solids, and a fade to transparent keeps its colour', () => {
    const solid = renderGenerated({ kind: 'solid', color: '#ff000080' });
    expect(solid.name).toBe('Solid FF000080');
    expect(alphaAt(solid, 3, 3)).toBe(0x80);
    expect(renderGenerated({ kind: 'solid', color: '#ff0000ff' }).name).toBe('Solid FF0000');
    // Red to transparent black: halfway is still pure red, half see-through.
    const fade = renderGenerated({ kind: 'gradient', from: '#ff0000ff', to: '#00000000', direction: 'horizontal' });
    const mid = fade.w >> 1;
    expect(rgbAt(fade, mid, 5)).toEqual([255, 0, 0]);
    expect(Math.abs(alphaAt(fade, mid, 5) - 128)).toBeLessThanOrEqual(1);
    expect(alphaAt(fade, fade.w - 1, 5)).toBe(0);
  });

  it('turns premultiplied pixels back into straight alpha', () => {
    const px = Buffer.from([0, 0, 64, 128, 0, 0, 0, 0, 10, 20, 30, 255]);
    expect([...unpremultiply(px)]).toEqual([0, 0, 128, 128, 0, 0, 0, 0, 10, 20, 30, 255]);
  });

  it('rejects anything that is not a known kind, #rrggbb colour or direction', () => {
    expect(() => renderGenerated({ kind: 'solid', color: 'red' })).toThrow();
    expect(() => renderGenerated({ kind: 'gradient', from: '#000000', to: '#ffffff', direction: '../x' })).toThrow();
    expect(() => renderGenerated({ kind: 'video' })).toThrow();
  });

  it('writes a top-down 32-bit BMP header', () => {
    const bmp = encodeBmp(2, 3, Buffer.alloc(2 * 3 * 4));
    expect(bmp.toString('ascii', 0, 2)).toBe('BM');
    expect(bmp.readUInt32LE(2)).toBe(54 + 24);
    expect(bmp.readInt32LE(18)).toBe(2);
    expect(bmp.readInt32LE(22)).toBe(-3);
    expect(bmp.readUInt16LE(28)).toBe(32);
  });
});
