import json, copy, datetime

src = 'C:/Users/Krasen/Desktop/XLETH/scripts/theming-audit-enriched.json'
with open(src, encoding='utf-8') as f:
    data = json.load(f)

matches = data['matches']

# ── 1. Chrome-layout re-attribution ─────────────────────────────────────────
CHROME_TOKEN_MAP = {
    'bg':     '--theme-bg-surface',
    'border': '--theme-border-subtle',
    'shadow': '--theme-chrome-shadow',
    'fg':     '--theme-chrome-titlebar-fg',
}

def norm_path(p):
    return p.replace('\\', '/') if p else ''

chrome_hits = 0
for m in matches:
    if m.get('subsystem') == 'chrome-layout':
        hint = (m.get('elementHint') or '').lower()
        tok = CHROME_TOKEN_MAP.get(hint)
        if tok:
            m['originalSubsystem'] = 'chrome-layout'
            m['subsystem'] = 'panel-chrome'
            m['confidence'] = 'high'
            m['proposedTokenName'] = tok
            chrome_hits += 1
        # entries without a recognized hint stay as chrome-layout / no-fit

print(f'chrome-layout -> panel-chrome: {chrome_hits} entries updated')

# ── 2. Stock-effects dynamics/distortion → shared ────────────────────────────
SE_SUBSYSTEMS = {'stock-effects.dynamics', 'stock-effects.distortion'}

# hint→token for shared effects tokens
SE_TOKEN_MAP = {
    'shadow': '--theme-fx-plugin-shadow',
    'bg':     '--theme-fx-plugin-bg',
    'fg':     '--theme-fx-plugin-titlebar-fg',
    'canvas-stroke': '--theme-fx-plugin-canvas-stroke',
}

se_hits = 0
for m in matches:
    if m.get('subsystem') in SE_SUBSYSTEMS and m.get('confidence') in ('no-fit', 'low'):
        hint = (m.get('elementHint') or '').lower()
        tok = SE_TOKEN_MAP.get(hint)
        if tok:
            m['originalSubsystem'] = m['subsystem']
            m['subsystem'] = 'stock-effects.shared'
            m['confidence'] = 'high'
            m['proposedTokenName'] = tok
            se_hits += 1

print(f'stock-effects dynamics/distortion -> shared: {se_hits} entries updated')

# ── 3. EQ positional mapping ─────────────────────────────────────────────────
EQ_BAND_COLORS = [
    '#33CED6', '#FF6B6B', '#69DB7C', '#FFA94D',   # bands 1-4
    '#748FFC', '#B197FC', '#FFD93D', '#FF6B9D',   # bands 5-8
    '#4ECDC4', '#FC5C65', '#45AAF2', '#FED330',   # bands 9-12
    '#A55EEA', '#26DE81', '#FD9644', '#2BCBBA',   # bands 13-16
]
EQ_HEX_TO_TOKEN = {c.upper(): f'--theme-eq-band-{i+1}' for i, c in enumerate(EQ_BAND_COLORS)}

eq_hits = 0
for m in matches:
    path_norm = norm_path(m.get('path', ''))
    if 'eqStore' in path_norm:
        raw = (m.get('matchedText') or '').upper().strip()
        tok = EQ_HEX_TO_TOKEN.get(raw)
        if tok:
            m['confidence'] = 'high'
            m['proposedTokenName'] = tok
            eq_hits += 1

print(f'EQ positional mapping: {eq_hits} entries updated')

# ── 4. Cluster 7+8 LOW→NO-FIT ────────────────────────────────────────────────
# grid-editor and piano-roll-resize-handle entries confirmed exempt
NO_FIT_LINES = {2679, 2720, 2721, 3806, 3807, 3810, 3811}

nf_hits = 0
for m in matches:
    path_norm = norm_path(m.get('path', ''))
    if 'app.css' in path_norm:
        line = m.get('line') or m.get('lineNumber') or m.get('sourceLine')
        if line in NO_FIT_LINES and m.get('confidence') == 'low':
            m['confidence'] = 'no-fit'
            m['proposedTokenName'] = None
            nf_hits += 1

print(f'cluster 7+8 LOW->NO-FIT: {nf_hits} entries flipped')

# ── 5. Recompute summary counts ───────────────────────────────────────────────
from collections import Counter
cc = Counter(m.get('confidence') for m in matches)
data['confidenceCounts'] = {
    'high':          cc.get('high', 0),
    'medium':        cc.get('medium', 0),
    'low':           cc.get('low', 0),
    'no-fit':        cc.get('no-fit', 0),
    'false-positive':cc.get('false-positive', 0),
}

# dispatchStats: count subsystem assignments
sc = Counter(m.get('subsystem') for m in matches)
unmatched = cc.get('no-fit', 0)
data['dispatchStats'] = {
    'total':     len(matches),
    'unmatched': unmatched,
    'bySubsystem': dict(sc.most_common()),
}

data['_mutatedAt'] = datetime.datetime.utcnow().isoformat() + 'Z'

with open(src, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)

print('Done. New confidence counts:', data['confidenceCounts'])
print('Total matches:', len(matches))
