// Single source of truth for the Plugin UI Designer build flag.
// Read import.meta.env only here; everything else imports DESIGNER_ENABLED.
//
// Set VITE_XLETH_PLUGIN_UI_DESIGNER=1 (or "true") at build/dev time to compile in.
// When false/undefined, the Designer module subtree is never imported because
// CompressorPanel guards its lazy() import on this constant.

const raw = (import.meta?.env && import.meta.env.VITE_XLETH_PLUGIN_UI_DESIGNER) ?? ''

export const DESIGNER_ENABLED = raw === '1' || raw === 'true'
