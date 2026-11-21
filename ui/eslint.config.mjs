// Minimal ESLint setup. The only rule enabled today guards PPQ tick/beat
// arithmetic — see the selectors below. Add rules deliberately; this is not
// meant to grow into a general style linter.

const ppqMessage =
  'Raw PPQ arithmetic outside constants/timeline.js — use ticksToBeats()/beatsToTicks() instead.'

export default [
  {
    files: ['src/**/*.{js,jsx}'],
    ignores: ['src/constants/timeline.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // One icon family: Phosphor via ui-kit/icons (docs/ICON_PROPOSAL.md). TS files are covered by
      // ui-kit/__tests__/icons.test.tsx, which ESLint does not lint.
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'lucide-react', message: 'Use <Icon name="…" /> from ui-kit/icons (Phosphor).' },
          { name: '@phosphor-icons/react', message: 'Use <Icon name="…" /> from ui-kit/icons; add the name to scripts/gen-icons.mjs.' },
        ],
      }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "BinaryExpression[operator='/'][right.name='PPQ']",
          message: ppqMessage,
        },
        {
          selector: "BinaryExpression[operator='*'][right.name='PPQ']",
          message: ppqMessage,
        },
        {
          selector: "BinaryExpression[operator='*'][left.name='PPQ']",
          message: ppqMessage,
        },
      ],
    },
  },
]
