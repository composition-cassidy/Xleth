import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import FxGraphEffectPicker from './FxGraphEffectPicker';

function render(props: Partial<React.ComponentProps<typeof FxGraphEffectPicker>> = {}) {
  return renderToStaticMarkup(
    <FxGraphEffectPicker
      onSelect={props.onSelect ?? vi.fn()}
      onCancel={props.onCancel ?? vi.fn()}
      vstPlugins={props.vstPlugins}
    />,
  );
}

describe('FxGraphEffectPicker', () => {
  it('renders a search field, a cancel control, and a labelled dialog', () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Add Effect Node"');
    expect(html).toContain('xleth-fx-graph-effect-picker__search-input');
    expect(html).toContain('xleth-fx-graph-effect-picker__cancel');
  });

  it('lists stock effects from the shared Mixer Chain catalog as selectable options', () => {
    const html = render();
    // Stock effects exposed by the Mixer Chain appear as graph picker options.
    expect(html).toContain('data-plugin-id="compressor"');
    expect(html).toContain('data-plugin-id="reverb"');
    expect(html).toContain('data-plugin-id="xletheq"');
    expect(html).toContain('role="option"');
    expect(html).toContain('data-kind="stock"');
  });

  it('lists scanned VST plugins from the same source the Mixer Chain uses', () => {
    const html = render({
      vstPlugins: [{ id: 'vst-acme-reverb', name: 'Acme Reverb', vendor: 'Acme' }],
    });
    expect(html).toContain('data-plugin-id="vst-acme-reverb"');
    expect(html).toContain('data-kind="vst"');
    expect(html).toContain('Acme Reverb - Acme');
    expect(html).toContain('VST3');
  });

  it('shows the no-plugins hint instead of VST options when nothing is scanned', () => {
    const html = render({ vstPlugins: [] });
    expect(html).toContain('xleth-fx-graph-effect-picker__group-empty');
    expect(html).toContain('No plugins scanned');
    expect(html).not.toContain('data-kind="vst"');
  });

  it('renders only tokenized class hooks, no inline color styling', () => {
    const html = render({
      vstPlugins: [{ id: 'vst-1', name: 'Plug', vendor: 'V' }],
    });
    // No inline styles at all, so no hardcoded production colors can leak in.
    expect(html).not.toMatch(/style="/);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/rgb\(/);
  });
});
