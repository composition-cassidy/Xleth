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
