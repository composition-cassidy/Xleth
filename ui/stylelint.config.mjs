// Guard for the UI kit (ui/DESIGN.md section 2). `npm run lint:css` runs this on
// ui-kit/** and **/*.module.css only; legacy sheets are NOT linted (they shrink by
// deletion, ratcheted by `npm run check:legacy-css`).
//
// Rejected outside ui-kit/tokens.css:
//   - hex colours, named colours, rgb()/rgba()/hsl()/hsla() (and other colour functions)
//   - px font sizes
//   - `transition: all`
// Colours live in tokens.css and are referenced as var(--ui-*) everywhere else.
// No plugins: every rule below is built into stylelint.

const COLOUR_FUNCTIONS = ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color'];

export default {
  allowEmptyInput: true,
  rules: {
    'color-no-hex': true,
    'color-named': 'never',
    'function-disallowed-list': COLOUR_FUNCTIONS,
    'declaration-property-value-disallowed-list': {
      // Font sizes come from the --type-* tokens (or rem/em), never raw px.
      'font-size': [/\d(\.\d+)?px\b/i],
      // The shorthand can smuggle a px size in as well.
      font: [/\d(\.\d+)?px\b/i],
      // Animate named properties only.
      transition: [/(^|[\s,])all(\s|,|$)/i],
      'transition-property': [/(^|[\s,])all(\s|,|$)/i],
    },
  },
  overrides: [
    {
      // The single place colours may be defined.
      files: ['**/ui-kit/tokens.css'],
      rules: {
        'color-no-hex': null,
        'color-named': null,
        'function-disallowed-list': null,
      },
    },
  ],
};
