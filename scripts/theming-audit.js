#!/usr/bin/env node
'use strict';

/* Xleth theming audit — Phase 0 Track A.
 * Scans ui/src/** for hardcoded color and chrome literals, groups by
 * spec §3.4 subsystem, and writes:
 *   - scripts/theming-audit-output.json     (main inventory)
 *   - scripts/theming-audit-rename-map.json (precursor `var(--xxx)` rename plan)
 *
 * Read-only. Does not modify any source files.
 */

const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..');
const UI_NODE_MODULES = path.join(REPO_ROOT, 'ui', 'node_modules');
const SCRIPTS_NODE_MODULES = path.join(__dirname, 'node_modules');

function resolveDep(name) {
  const resolved = require.resolve(name, {
    paths: [SCRIPTS_NODE_MODULES, UI_NODE_MODULES],
  });
  return require(resolved);
}

const parser = resolveDep('@babel/parser');
const traverseModule = resolveDep('@babel/traverse');
const traverse = traverseModule.default || traverseModule;
const fg = resolveDep('fast-glob');
const csstree = resolveDep('css-tree');

const DEBUG = process.env.THEMING_AUDIT_DEBUG === '1';
const debug = (...a) => { if (DEBUG) console.error('[debug]', ...a); };

// ─── CSS named colors (148, plus `transparent` excluded from named-flag) ──
const CSS_NAMED_COLORS = new Set([
  'aliceblue','antiquewhite','aqua','aquamarine','azure','beige','bisque',
  'black','blanchedalmond','blue','blueviolet','brown','burlywood','cadetblue',
  'chartreuse','chocolate','coral','cornflowerblue','cornsilk','crimson','cyan',
  'darkblue','darkcyan','darkgoldenrod','darkgray','darkgrey','darkgreen',
  'darkkhaki','darkmagenta','darkolivegreen','darkorange','darkorchid','darkred',
  'darksalmon','darkseagreen','darkslateblue','darkslategray','darkslategrey',
  'darkturquoise','darkviolet','deeppink','deepskyblue','dimgray','dimgrey',
  'dodgerblue','firebrick','floralwhite','forestgreen','fuchsia','gainsboro',
  'ghostwhite','gold','goldenrod','gray','grey','green','greenyellow','honeydew',
  'hotpink','indianred','indigo','ivory','khaki','lavender','lavenderblush',
  'lawngreen','lemonchiffon','lightblue','lightcoral','lightcyan',
  'lightgoldenrodyellow','lightgray','lightgrey','lightgreen','lightpink',
  'lightsalmon','lightseagreen','lightskyblue','lightslategray','lightslategrey',
  'lightsteelblue','lightyellow','lime','limegreen','linen','magenta','maroon',
  'mediumaquamarine','mediumblue','mediumorchid','mediumpurple','mediumseagreen',
  'mediumslateblue','mediumspringgreen','mediumturquoise','mediumvioletred',
  'midnightblue','mintcream','mistyrose','moccasin','navajowhite','navy',
  'oldlace','olive','olivedrab','orange','orangered','orchid','palegoldenrod',
  'palegreen','paleturquoise','palevioletred','papayawhip','peachpuff','peru',
  'pink','plum','powderblue','purple','rebeccapurple','red','rosybrown',
  'royalblue','saddlebrown','salmon','sandybrown','seagreen','seashell','sienna',
  'silver','skyblue','slateblue','slategray','slategrey','snow','springgreen',
  'steelblue','tan','teal','thistle','tomato','turquoise','violet','wheat',
  'white','whitesmoke','yellow','yellowgreen','transparent',
]);
const NAMED_FLAGGABLE = new Set([...CSS_NAMED_COLORS].filter(c => c !== 'transparent'));

// ─── Spec §3.4 subsystem catalog ──────────────────────────────────────────
const SUBSYSTEMS = {
  'transport-bar':           { displayName: 'Transport bar', section: '3.4.1' },
  'menu-bar-toolbar':        { displayName: 'Menu bar and top toolbar', section: '3.4.2' },
  'context-menus':           { displayName: 'Context menus', section: '3.4.3' },
  'dialogs-modals':          { displayName: 'Dialogs, modals, popovers, tooltips', section: '3.4.4' },
  'buttons':                 { displayName: 'Generic buttons', section: '3.4.5' },
  'mixer':                   { displayName: 'Mixer', section: '3.4.6' },
  'stock-effects.shared':    { displayName: 'Stock effects — shared primitives', section: '3.4.7' },
  'stock-effects.eq':        { displayName: 'Stock effects — Xleth EQ', section: '3.4.8' },
  'stock-effects.dynamics':  { displayName: 'Stock effects — Dynamics', section: '3.4.9' },
  'stock-effects.filter':    { displayName: 'Stock effects — Filter', section: '3.4.10', plannedDeferred: true },
  'stock-effects.modulation':{ displayName: 'Stock effects — Modulation', section: '3.4.11' },
  'stock-effects.time':      { displayName: 'Stock effects — Time (Delay, Reverb)', section: '3.4.12' },
  'stock-effects.distortion':{ displayName: 'Stock effects — Distortion', section: '3.4.13' },
  'piano-roll':              { displayName: 'Piano roll', section: '3.4.14' },
  'sampler':                 { displayName: 'Sampler UI', section: '3.4.15' },
  'timeline':                { displayName: 'Timeline', section: '3.4.16' },
  'grid-editor':             { displayName: 'Grid editor', section: '3.4.17' },
  'sample-selector':         { displayName: 'Sample Selector', section: '3.4.18' },
  'node-editor':             { displayName: 'Node Editor', section: '3.4.19' },
  'syllable-splitter':       { displayName: 'Syllable Splitter', section: '3.4.20' },
  'lip-sync-picker':         { displayName: 'Lip Sync Picker', section: '3.4.21' },
  'preview-player':          { displayName: 'Preview player', section: '3.4.22' },
  'project-media':           { displayName: 'Project Media / Sources', section: '3.4.23' },
  'pattern-list':            { displayName: 'Pattern list sidebar', section: '3.4.24' },
  'chrome-layout':           { displayName: 'Chrome and layout (§3.3)', section: '3.3', synthetic: true },
};

const norm = p => p.split(path.sep).join('/');

// First-match-wins file → subsystem mapping.
function pathToSubsystem(rel) {
  const p = norm(rel);

  // §3.4.1 transport
  if (/^ui\/src\/components\/TransportBar\.jsx$/.test(p)) return 'transport-bar';
  if (/^ui\/src\/transportStore\.js$/.test(p)) return 'transport-bar';
  if (/^ui\/src\/services\/PlayheadClock\.js$/.test(p)) return 'transport-bar';
  if (/^ui\/src\/constants\/meterSlots\.js$/.test(p)) return 'transport-bar';

  // §3.4.2 menu bar / top toolbar
  if (/^ui\/src\/components\/(TitleBar|SettingsPanel|AudioDeviceSelector)\.jsx$/.test(p)) return 'menu-bar-toolbar';

  // §3.4.3 context menus
  if (/^ui\/src\/components\/ContextMenu\.jsx$/.test(p)) return 'context-menus';
  if (/^ui\/src\/components\/timeline\/TrackContextMenu\.jsx$/.test(p)) return 'context-menus';

  // §3.4.4 dialogs / modals / popovers / tooltips (incl. exportPresets)
  if (/^ui\/src\/components\/(ExportDialog|VideoExportDialog|UnsavedChangesDialog|MissingPluginsDialog|Toast)\.jsx$/.test(p)) return 'dialogs-modals';
  if (/^ui\/src\/components\/timeline\/(ConfirmConvertDialog|QuantizeDialog)\.jsx$/.test(p)) return 'dialogs-modals';
  if (/^ui\/src\/components\/SyllableSplitter\/SyllableSplitterModal\.jsx$/.test(p)) return 'dialogs-modals';
  if (/^ui\/src\/components\/exportPresets\//.test(p)) return 'dialogs-modals';

  // §3.4.7–3.4.13 stock effects (route specific files BEFORE generic mixer/)
  if (/^ui\/src\/components\/sampler\/Knob\.jsx$/.test(p)) return 'stock-effects.shared';
  if (/^ui\/src\/utils\/sliderHelpers\.js$/.test(p)) return 'stock-effects.shared';

  if (/^ui\/src\/components\/mixer\/EqPanel\.jsx$/.test(p)) return 'stock-effects.eq';
  if (/^ui\/src\/stores\/eqStore\.js$/.test(p)) return 'stock-effects.eq';

  if (/^ui\/src\/components\/mixer\/(CompressorPanel|LimiterPanel|SmartBalancePanel|TransientProcPanel)\.jsx$/.test(p)) return 'stock-effects.dynamics';
  if (/^ui\/src\/stores\/(compressor|limiter|smartBalance|transientProc)Store\.js$/.test(p)) return 'stock-effects.dynamics';

  if (/^ui\/src\/components\/mixer\/(ChorusPanel|FlangerPanel|PhaserPanel)\.jsx$/.test(p)) return 'stock-effects.modulation';
  if (/^ui\/src\/stores\/(chorus|flanger|phaser)Store\.js$/.test(p)) return 'stock-effects.modulation';

  if (/^ui\/src\/components\/mixer\/(DelayPanel|ReverbPanel)\.jsx$/.test(p)) return 'stock-effects.time';
  if (/^ui\/src\/stores\/(delay|reverb)Store\.js$/.test(p)) return 'stock-effects.time';

  // OTTPanel = legacy name for Overdone (per Krasen, Phase 0 Track A confirmation)
  if (/^ui\/src\/components\/mixer\/(DistortionPanel|WaveshaperPanel|OTTPanel)\.jsx$/.test(p)) return 'stock-effects.distortion';
  if (/^ui\/src\/stores\/(distortion|waveshaper|overdone)Store\.js$/.test(p)) return 'stock-effects.distortion';

  // §3.4.19 node editor (specific files under mixer/ and root)
  if (/^ui\/src\/components\/mixer\/NodeEditor\.jsx$/.test(p)) return 'node-editor';
  if (/^ui\/src\/NodeEditorWindow\.jsx$/.test(p)) return 'node-editor';
  if (/^ui\/src\/stores\/nodeGraphStore\.js$/.test(p)) return 'node-editor';

  // §3.4.6 mixer (after effects + node editor routed)
  if (/^ui\/src\/components\/mixer\/(MixerPanel|MixerStrip|MasterStrip|VolumeFader|PeakMeter|EffectChainPanel|EffectModule|ScanProgressBar|VstBrowser)\.jsx$/.test(p)) return 'mixer';
  if (/^ui\/src\/stores\/(mixerStore|effectChainStore|vstStore)\.js$/.test(p)) return 'mixer';

  // §3.4.14 piano roll
  if (/^ui\/src\/components\/pianoRoll\//.test(p)) return 'piano-roll';

  // §3.4.15 sampler (after Knob.jsx routed to shared)
  if (/^ui\/src\/components\/sampler\//.test(p)) return 'sampler';

  // §3.4.24 pattern list (specific file before generic timeline/)
  if (/^ui\/src\/components\/timeline\/PatternListPanel\.jsx$/.test(p)) return 'pattern-list';

  // §3.4.16 timeline
  if (/^ui\/src\/components\/timeline\//.test(p)) return 'timeline';
  if (/^ui\/src\/components\/TimelineView\.jsx$/.test(p)) return 'timeline';
  if (/^ui\/src\/hooks\/useTimeline/.test(p)) return 'timeline';
  if (/^ui\/src\/services\/EditCursor\.js$/.test(p)) return 'timeline';
  if (/^ui\/src\/constants\/timeline\.js$/.test(p)) return 'timeline';
  if (/^ui\/src\/timelineEvents\.js$/.test(p)) return 'timeline';
  if (/^ui\/src\/utils\/(quantize|waveformRenderer)\.js$/.test(p)) return 'timeline';

  // §3.4.17 grid editor
  if (/^ui\/src\/components\/(GridEditorOverlay|GridLayoutTab)\.jsx$/.test(p)) return 'grid-editor';

  // §3.4.18 sample selector
  if (/^ui\/src\/components\/(SampleSelectorTab|SampleRow|SampleGroup)\.jsx$/.test(p)) return 'sample-selector';
  if (/^ui\/src\/constants\/labels\.js$/.test(p)) return 'sample-selector';

  // §3.4.20 syllable splitter (modal already routed to dialogs-modals)
  if (/^ui\/src\/components\/SyllableSplitter\//.test(p)) return 'syllable-splitter';

  // §3.4.21 lip-sync picker (SamplePicker = internal name)
  if (/^ui\/src\/components\/SamplePicker\//.test(p)) return 'lip-sync-picker';

  // §3.4.22 preview player
  if (/^ui\/src\/components\/VideoPreview\.jsx$/.test(p)) return 'preview-player';

  // §3.4.23 project media / sources
  if (/^ui\/src\/components\/(ProjectMediaTab|SourceCard|ImportDropZone)\.jsx$/.test(p)) return 'project-media';

  // §3.3 chrome / layout — synthetic bucket
  if (/^ui\/src\/(App|main|NodeEditorWindow)\.jsx?$/.test(p)) return 'chrome-layout';
  if (/^ui\/src\/components\/(LeftPanel|ResizablePanel|ProgressBar)\.jsx$/.test(p)) return 'chrome-layout';
  if (/^ui\/src\/styles\//.test(p)) return 'chrome-layout';

  return 'unknown';
}

// ─── Color matchers ───────────────────────────────────────────────────────
const HEX_RE  = /#([0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{3})\b/g;
const RGB_RE  = /\brgba?\s*\(/gi;
const HSL_RE  = /\bhsla?\s*\(/gi;
const GRAD_RE = /\b(linear|radial|conic)-gradient\s*\(/gi;
const NAMED_RE = new RegExp('\\b(' + [...NAMED_FLAGGABLE].join('|') + ')\\b', 'gi');
const DIM_LITERAL_RE = /\b\d+(?:\.\d+)?(?:px|em|rem|%)\b/;

const KNOWN_DIM_PROPS_JS = new Set([
  'height','width','minHeight','maxHeight','minWidth','maxWidth',
  'padding','paddingTop','paddingBottom','paddingLeft','paddingRight',
  'margin','marginTop','marginBottom','marginLeft','marginRight',
  'borderRadius','borderWidth','top','left','right','bottom','gap',
]);
const KNOWN_DIM_PROPS_CSS = new Set([
  'height','width','min-height','max-height','min-width','max-width',
  'padding','padding-top','padding-bottom','padding-left','padding-right',
  'margin','margin-top','margin-bottom','margin-left','margin-right',
  'border-radius','border-width','top','left','right','bottom','gap',
]);

function findMatchingParen(str, openIdx) {
  let depth = 1;
  for (let i = openIdx + 1; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Find every color literal inside a flat string. Returns [{offset,length,kind,text}].
function classifyString(str) {
  const out = [];
  let m;

  HEX_RE.lastIndex = 0;
  while ((m = HEX_RE.exec(str)) !== null) {
    out.push({ offset: m.index, length: m[0].length, kind: 'hex', text: m[0] });
  }

  for (const [re, kindFn] of [
    [RGB_RE,  s => s.toLowerCase().startsWith('rgba') ? 'rgba' : 'rgb'],
    [HSL_RE,  s => s.toLowerCase().startsWith('hsla') ? 'hsla' : 'hsl'],
    [GRAD_RE, s => 'gradient-' + s.toLowerCase().match(/^(linear|radial|conic)/)[1]],
  ]) {
    re.lastIndex = 0;
    while ((m = re.exec(str)) !== null) {
      const close = findMatchingParen(str, m.index + m[0].length - 1);
      const length = close !== -1 ? close - m.index + 1 : m[0].length;
      const text = str.slice(m.index, m.index + length);
      out.push({ offset: m.index, length, kind: kindFn(m[0]), text });
    }
  }

  NAMED_RE.lastIndex = 0;
  while ((m = NAMED_RE.exec(str)) !== null) {
    out.push({ offset: m.index, length: m[0].length, kind: 'named', text: m[0] });
  }

  // Dedupe overlaps (gradient swallows inner hex, etc.)
  out.sort((a, b) => a.offset - b.offset);
  const filtered = [];
  let lastEnd = -1;
  for (const x of out) {
    if (x.offset >= lastEnd) { filtered.push(x); lastEnd = x.offset + x.length; }
  }
  return filtered;
}

function looksLikeNonStyle(str) {
  if (str.length > 80 && /\s\w+\s\w+\s\w+/.test(str)) return true;
  if (/^(https?:|file:|xleth-media:|\/|[A-Za-z]:[\\/])/.test(str)) return true;
  if (/\.(jsx?|tsx?|css|scss|json|md|html|wav|mp4|mp3|png|jpe?g|svg|gif|webp|woff2?)$/i.test(str)) return true;
  return false;
}

function makeMatch(line, column, matchedText, kind, surroundingContext, elementHint, ambiguous, ambiguityReason) {
  return {
    line, column, matchedText, kind, surroundingContext,
    elementHint: elementHint || null,
    proposedTokenName: null, // Conservative: never auto-name. Track B decides.
    ambiguous: !!ambiguous,
    ambiguityReason: ambiguityReason || null,
  };
}

function getSurrounding(sourceLines, line) {
  const start = Math.max(0, line - 4);
  const end = Math.min(sourceLines.length, line + 3);
  return sourceLines.slice(start, end).map((l, i) => {
    const lineNum = start + i + 1;
    const marker = lineNum === line ? '>' : ' ';
    return `${marker} ${String(lineNum).padStart(4)}: ${l}`;
  }).join('\n');
}

// ─── JS/JSX/TS scanner ────────────────────────────────────────────────────
function inferStylingContext(nodePath) {
  let cur = nodePath;
  while (cur) {
    const node = cur.node;

    // JSX style={...}
    if (node && node.type === 'JSXAttribute' && node.name && node.name.name === 'style') {
      return { context: 'jsx-style', detail: null };
    }
    // Object property whose key looks style-related (style={{ backgroundColor: '#...' }}, palette objects)
    if (node && node.type === 'ObjectProperty') {
      const k = node.key && (node.key.name || node.key.value);
      if (typeof k === 'string') {
        if (KNOWN_DIM_PROPS_JS.has(k)) return { context: 'object-property', detail: k };
        if (/color|background|fill|stroke|border|shadow|outline|tint/i.test(k)) {
          return { context: 'object-property', detail: k };
        }
      }
    }
    // ctx.fillStyle = '#…' / ctx.strokeStyle / ctx.shadowColor
    if (node && node.type === 'AssignmentExpression' && node.left && node.left.type === 'MemberExpression') {
      const prop = node.left.property;
      if (prop && (prop.name === 'fillStyle' || prop.name === 'strokeStyle' || prop.name === 'shadowColor')) {
        return { context: 'canvas', detail: prop.name };
      }
    }
    // x.addColorStop(0, '#…')
    if (node && node.type === 'CallExpression') {
      const callee = node.callee;
      if (callee && callee.type === 'MemberExpression' && callee.property && callee.property.name === 'addColorStop') {
        return { context: 'addColorStop', detail: null };
      }
    }
    // const FOO_COLOR = '#…'
    if (node && node.type === 'VariableDeclarator' && node.id && node.id.name) {
      if (/color|colour|fill|stroke|bg|background|border|tint|hue|palette/i.test(node.id.name)) {
        return { context: 'named-const', detail: node.id.name };
      }
    }
    cur = cur.parentPath;
  }
  return null;
}

function elementHintFromContext(ctx) {
  if (!ctx) return null;
  if (ctx.context === 'object-property') {
    const k = ctx.detail.toLowerCase();
    if (KNOWN_DIM_PROPS_JS.has(ctx.detail)) return ctx.detail;
    if (/background/.test(k)) return 'bg';
    if (k === 'color') return 'fg';
    if (/border/.test(k)) return 'border';
    if (/fill/.test(k)) return 'fill';
    if (/stroke/.test(k)) return 'stroke';
    if (/shadow/.test(k)) return 'shadow';
    if (/outline/.test(k)) return 'outline';
    if (/tint/.test(k)) return 'tint';
    return ctx.detail;
  }
  if (ctx.context === 'canvas') {
    if (ctx.detail === 'fillStyle') return 'canvas-fill';
    if (ctx.detail === 'strokeStyle') return 'canvas-stroke';
    if (ctx.detail === 'shadowColor') return 'shadow';
  }
  if (ctx.context === 'addColorStop') return 'gradient-stop';
  if (ctx.context === 'named-const') return ctx.detail;
  if (ctx.context === 'jsx-style') return 'jsx-style';
  return null;
}

function scanJsFile(rel, source) {
  const matches = [];
  let ast;
  try {
    ast = parser.parse(source, {
      sourceType: 'module',
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: [
        'jsx',
        ['decorators', { decoratorsBeforeExport: true }],
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'objectRestSpread',
        'optionalChaining',
        'nullishCoalescingOperator',
        'dynamicImport',
        'topLevelAwait',
        ...(rel.endsWith('.ts') || rel.endsWith('.tsx') ? ['typescript'] : []),
      ],
    });
  } catch (err) {
    debug('parse error', rel, err.message);
    return matches;
  }

  const sourceLines = source.split(/\r?\n/);

  function recordFromString(strValue, loc, nodePath, fromTemplate) {
    if (!loc) return;
    const found = classifyString(strValue);
    if (!found.length) return;
    const ctx = inferStylingContext(nodePath);
    const inStyling = !!ctx;
    if (!inStyling && looksLikeNonStyle(strValue)) return;
    const elementHint = elementHintFromContext(ctx);

    for (const f of found) {
      if (!inStyling && (f.kind === 'named' || (f.kind === 'hex' && f.length <= 4))) continue;
      const line = loc.start.line;
      const column = loc.start.column + 1 + f.offset;
      let ambiguous = !inStyling || !elementHint;
      let reason = null;
      if (!inStyling) {
        reason = 'String not in obvious styling context — element role unknown';
      } else if (!elementHint) {
        reason = 'Styling context detected but element role could not be inferred';
      }
      if (fromTemplate) {
        ambiguous = true;
        reason = (reason ? reason + '; ' : '') +
          'Template literal — value may be partially dynamic at runtime';
      }
      matches.push(makeMatch(line, column, f.text, f.kind,
        getSurrounding(sourceLines, line), elementHint, ambiguous, reason));
    }
  }

  traverse(ast, {
    StringLiteral(p) {
      // Skip imports / require sources
      const parent = p.parent;
      if (parent && (parent.type === 'ImportDeclaration' || parent.type === 'ExportAllDeclaration' || parent.type === 'ExportNamedDeclaration')) return;
      if (parent && parent.type === 'CallExpression' && parent.callee && parent.callee.name === 'require' && parent.arguments[0] === p.node) return;
      recordFromString(p.node.value, p.node.loc, p, false);
    },
    TemplateLiteral(p) {
      for (const q of p.node.quasis) {
        if (!q.value || !q.value.cooked) continue;
        recordFromString(q.value.cooked, q.loc, p, true);
      }
    },
  });

  // Chrome dimension scan — only if file has ≥1 color match
  if (matches.length > 0) {
    traverse(ast, {
      ObjectProperty(p) {
        const k = p.node.key && (p.node.key.name || p.node.key.value);
        if (typeof k !== 'string' || !KNOWN_DIM_PROPS_JS.has(k)) return;
        const val = p.node.value;
        if (!val) return;
        let str = null;
        if (val.type === 'StringLiteral') str = val.value;
        else if (val.type === 'TemplateLiteral' && val.expressions.length === 0) {
          str = val.quasis.map(q => q.value.cooked).join('');
        }
        if (!str || !DIM_LITERAL_RE.test(str)) return;
        const line = p.node.loc.start.line;
        matches.push(makeMatch(line, p.node.loc.start.column, str, 'chrome-dimension',
          getSurrounding(sourceLines, line), k, true,
          'Probable chrome dimension — token candidate; human review required'));
      },
    });
  }

  return matches;
}

// ─── CSS scanner ──────────────────────────────────────────────────────────
function elementHintFromCssProperty(prop) {
  if (!prop) return null;
  if (prop === 'background' || prop === 'background-color') return 'bg';
  if (prop === 'color') return 'fg';
  if (prop.startsWith('border')) return 'border';
  if (prop === 'fill') return 'fill';
  if (prop === 'stroke') return 'stroke';
  if (prop.includes('shadow')) return 'shadow';
  if (prop === 'outline-color' || prop === 'outline') return 'outline';
  if (prop === 'caret-color') return 'caret';
  return null;
}

function collectCssValueMatches(valueNode) {
  const matches = [];
  csstree.walk(valueNode, function(node) {
    if (node.type === 'Hash') {
      matches.push({
        kind: 'hex',
        text: '#' + node.value,
        line: node.loc && node.loc.start.line,
        column: node.loc && node.loc.start.column,
      });
    } else if (node.type === 'Function') {
      const name = node.name.toLowerCase();
      if (name === 'var') return; // skip CSS var refs (precursor system, tracked separately)
      if (['rgb','rgba','hsl','hsla'].includes(name)) {
        matches.push({
          kind: name,
          text: csstree.generate(node),
          line: node.loc && node.loc.start.line,
          column: node.loc && node.loc.start.column,
        });
        return;
      }
      if (['linear-gradient','radial-gradient','conic-gradient'].includes(name)) {
        matches.push({
          kind: 'gradient-' + name.split('-')[0],
          text: csstree.generate(node),
          line: node.loc && node.loc.start.line,
          column: node.loc && node.loc.start.column,
        });
        return;
      }
    } else if (node.type === 'Identifier') {
      const id = node.name.toLowerCase();
      if (NAMED_FLAGGABLE.has(id)) {
        matches.push({
          kind: 'named',
          text: node.name,
          line: node.loc && node.loc.start.line,
          column: node.loc && node.loc.start.column,
        });
      }
    }
  });
  return matches;
}

function scanCssFile(rel, source) {
  const colorMatches = [];
  const pendingDims = [];
  const sourceLines = source.split(/\r?\n/);
  let ast;
  try {
    ast = csstree.parse(source, { positions: true, parseValue: true, parseAtrulePrelude: true });
  } catch (err) {
    debug('css parse error', rel, err.message);
    return colorMatches;
  }

  csstree.walk(ast, {
    visit: 'Declaration',
    enter(node) {
      // Skip custom-property declarations (they ARE the precursor system)
      if (node.property && node.property.startsWith('--')) return;

      const propName = node.property;
      const declLine = (node.loc && node.loc.start.line) || 0;

      const found = collectCssValueMatches(node.value);
      const elementHint = elementHintFromCssProperty(propName);
      for (const f of found) {
        const line = f.line || declLine;
        colorMatches.push(makeMatch(
          line, f.column || 0, f.text, f.kind,
          getSurrounding(sourceLines, line), elementHint,
          !elementHint, !elementHint ? `CSS property '${propName}' does not map to a known element role` : null
        ));
      }

      if (KNOWN_DIM_PROPS_CSS.has(propName)) {
        const valueText = csstree.generate(node.value);
        if (DIM_LITERAL_RE.test(valueText)) {
          pendingDims.push({ propName, line: declLine, valueText });
        }
      }
    },
  });

  if (colorMatches.length > 0) {
    for (const d of pendingDims) {
      colorMatches.push(makeMatch(
        d.line, 0, d.valueText.trim(), 'chrome-dimension',
        getSurrounding(sourceLines, d.line), d.propName, true,
        'CSS chrome dimension — token candidate; human review required'
      ));
    }
  }

  return colorMatches;
}

// ─── Precursor `var(--xxx)` rename map ────────────────────────────────────
const VAR_REF_RE = /var\(\s*(--[A-Za-z][A-Za-z0-9_-]*)/g;

function collectVarReferences(source) {
  const refs = {};
  let m;
  VAR_REF_RE.lastIndex = 0;
  while ((m = VAR_REF_RE.exec(source)) !== null) {
    refs[m[1]] = (refs[m[1]] || 0) + 1;
  }
  return refs;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const cwd = REPO_ROOT;
  console.log('Theming audit — Phase 0 Track A');
  console.log('Scanning ui/src/**');

  const patterns = ['ui/src/**/*.{js,jsx,ts,tsx,css,scss}'];
  const ignore = [
    '**/node_modules/**', '**/build/**', '**/dist/**', '**/out/**', '**/.git/**',
    '**/*.test.*', '**/*.spec.*', '**/__fixtures__/**', '**/__snapshots__/**',
  ];
  const files = await fg(patterns, { cwd, ignore, absolute: false, dot: false });
  files.sort();

  const bySubsystem = {};
  for (const [k, meta] of Object.entries(SUBSYSTEMS)) {
    bySubsystem[k] = {
      displayName: meta.displayName,
      section: meta.section,
      synthetic: !!meta.synthetic || undefined,
      plannedDeferred: !!meta.plannedDeferred || undefined,
      matchCount: 0,
      files: [],
    };
  }
  bySubsystem['unknown'] = {
    displayName: 'Unknown / unmapped — needs human review',
    section: null, matchCount: 0, files: [],
  };

  const renameMap = {}; // varName -> { totalRefs, subsystems:Set, files:[{path,count}] }
  let totalMatches = 0;
  let filesWithMatches = 0;
  let filesScanned = 0;

  for (const rel of files) {
    filesScanned++;
    if (filesScanned % 50 === 0) {
      console.log(`  scanned ${filesScanned} / ${files.length}`);
    }
    const abs = path.join(cwd, rel);
    let source;
    try {
      source = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      debug('read error', rel, err.message);
      continue;
    }

    const subsystem = pathToSubsystem(rel);

    // Var rename-map (every file type)
    const refs = collectVarReferences(source);
    for (const [v, count] of Object.entries(refs)) {
      if (!renameMap[v]) renameMap[v] = { totalRefs: 0, subsystems: new Set(), files: [] };
      renameMap[v].totalRefs += count;
      renameMap[v].subsystems.add(subsystem);
      renameMap[v].files.push({ path: rel, count });
    }

    // Color audit
    let matches;
    if (/\.(jsx?|tsx?)$/.test(rel)) matches = scanJsFile(rel, source);
    else if (/\.s?css$/.test(rel)) matches = scanCssFile(rel, source);
    else continue;

    if (!matches || matches.length === 0) continue;

    filesWithMatches++;
    totalMatches += matches.length;
    if (!bySubsystem[subsystem]) {
      bySubsystem[subsystem] = { displayName: subsystem, section: null, matchCount: 0, files: [] };
    }
    bySubsystem[subsystem].matchCount += matches.length;
    bySubsystem[subsystem].files.push({ path: rel, matchCount: matches.length, matches });
  }

  // Coverage
  const specKeys = Object.keys(SUBSYSTEMS).filter(k => SUBSYSTEMS[k].section && SUBSYSTEMS[k].section.startsWith('3.4'));
  const coverageReport = {
    spec_3_4_subsystems: specKeys.map(k => ({
      subsystem: k,
      section: SUBSYSTEMS[k].section,
      displayName: SUBSYSTEMS[k].displayName,
      matchCount: bySubsystem[k] ? bySubsystem[k].matchCount : 0,
      covered: (bySubsystem[k] ? bySubsystem[k].matchCount : 0) > 0,
      plannedDeferred: !!SUBSYSTEMS[k].plannedDeferred,
    })),
    missingSubsystems: specKeys.filter(k =>
      (!bySubsystem[k] || bySubsystem[k].matchCount === 0) && !SUBSYSTEMS[k].plannedDeferred
    ),
  };

  // Flat ambiguous list
  const ambiguousMatches = [];
  for (const [k, v] of Object.entries(bySubsystem)) {
    for (const f of v.files) {
      for (const m of f.matches) {
        if (m.ambiguous) ambiguousMatches.push({ subsystem: k, path: f.path, ...m });
      }
    }
  }

  // Rename map — needsReview when var is used in only one §3.4 subsystem
  const renameMapOut = {};
  for (const [varName, info] of Object.entries(renameMap)) {
    const subsystems = [...info.subsystems].sort();
    const realSubsystems = subsystems.filter(s => s !== 'unknown' && s !== 'chrome-layout');
    const distinctRealCount = new Set(realSubsystems).size;
    const needsReview = distinctRealCount === 1;
    renameMapOut[varName] = {
      totalRefs: info.totalRefs,
      subsystems,
      fileCount: info.files.length,
      sampleFiles: info.files.slice(0, 5).map(f => f.path),
      needsReview,
      reviewHint: needsReview
        ? `Used only in subsystem '${realSubsystems[0]}' — candidate for promotion to --theme-${realSubsystems[0]}-* token`
        : (realSubsystems.length === 0
            ? 'Used only in chrome/layout or unknown — keep as base token'
            : 'Used across multiple subsystems — keep as base token'),
    };
  }

  // Write output JSONs
  const outPath = path.join(__dirname, 'theming-audit-output.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalMatches,
    filesScanned,
    filesWithMatches,
    bySubsystem,
    ambiguousMatches,
    coverageReport,
  }, null, 2));

  const renamePath = path.join(__dirname, 'theming-audit-rename-map.json');
  fs.writeFileSync(renamePath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    note: "Precursor `var(--xxx)` references found in the codebase. needsReview=true means the var is used in only one §3.4 subsystem, making it a candidate for promotion to a subsystem-scoped --theme-<subsystem>-* token rather than a blind rename to --theme-<name>. Multi-subsystem vars stay as base tokens.",
    varCount: Object.keys(renameMapOut).length,
    needsReviewCount: Object.values(renameMapOut).filter(v => v.needsReview).length,
    vars: renameMapOut,
  }, null, 2));

  // Stdout summary
  console.log('');
  console.log('═══ Audit complete ═══');
  console.log(`Files scanned:       ${filesScanned}`);
  console.log(`Files with matches:  ${filesWithMatches}`);
  console.log(`Total matches:       ${totalMatches}`);
  console.log(`Ambiguous matches:   ${ambiguousMatches.length}`);
  console.log('');
  console.log('Per-subsystem counts:');
  const sorted = Object.entries(bySubsystem)
    .filter(([, v]) => v.matchCount > 0)
    .sort((a, b) => b[1].matchCount - a[1].matchCount);
  for (const [k, v] of sorted) {
    console.log(`  ${k.padEnd(28)} ${String(v.matchCount).padStart(5)}  (${v.files.length} files)`);
  }
  console.log('');
  console.log('Missing subsystems (no code, not planned-deferred):');
  if (coverageReport.missingSubsystems.length === 0) console.log('  (none)');
  else for (const m of coverageReport.missingSubsystems) console.log(`  - ${m}`);
  console.log('');
  console.log(`Output JSON:      ${path.relative(cwd, outPath)}`);
  console.log(`Rename-map JSON:  ${path.relative(cwd, renamePath)}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
