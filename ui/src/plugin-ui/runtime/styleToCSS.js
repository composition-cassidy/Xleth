// Converts the allow-listed NodeStyle object to a React inline-style object.
// Only the keys in ALLOWED_STYLE_KEYS (validate.js) reach here; anything else
// was already stripped by the validator.

const ALIGN_MAP = {
  start:   'flex-start',
  center:  'center',
  end:     'flex-end',
  stretch: 'stretch',
}

const JUSTIFY_MAP = {
  start:        'flex-start',
  center:       'center',
  end:          'flex-end',
  spaceBetween: 'space-between',
  spaceAround:  'space-around',
}

export function styleToCSS(style = {}) {
  const css = {}

  if (style.paddingPx !== undefined) {
    if (Array.isArray(style.paddingPx)) {
      css.padding = style.paddingPx.map(v => `${v}px`).join(' ')
    } else {
      css.padding = `${style.paddingPx}px`
    }
  }

  if (style.gapPx !== undefined)    css.gap       = `${style.gapPx}px`
  if (style.widthPx !== undefined)  css.width     = `${style.widthPx}px`
  if (style.heightPx !== undefined) css.height    = `${style.heightPx}px`
  if (style.growsToFill)            css.flex      = '1'
  if (style.flexBasis !== undefined) css.flexBasis = `${style.flexBasis}px`

  if (style.align)   css.alignItems    = ALIGN_MAP[style.align]   ?? style.align
  if (style.justify) css.justifyContent = JUSTIFY_MAP[style.justify] ?? style.justify

  return css
}
