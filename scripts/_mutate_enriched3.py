"""
Pass 3:
  Task 1 — Reverse cluster 7+8 exemption: no-fit -> high for grid-editor and piano-roll entries.
  Task 2 mechanical — Re-attribute #555566 entries + sampler #000 black key.
"""
import json, datetime
from collections import Counter

src = 'C:/Users/Krasen/Desktop/XLETH/scripts/theming-audit-enriched.json'
with open(src, encoding='utf-8') as f:
    data = json.load(f)

matches = data['matches']

# (path_fragment, line) -> (token, rationale)
PASS3_MAP = {
    # Task 1: cluster 7+8 reversals
    ('app.css', 2679): ('--theme-grid-editor-text-shadow',
                        'rgba(0,0,0,0.8) is the text-shadow on grid-editor cell labels; covered by new token.'),
    ('app.css', 2720): ('--theme-grid-editor-crosshair',
                        'rgba(255,255,255,0.15) is the crosshair gradient stop; covered by new token.'),
    ('app.css', 2721): ('--theme-grid-editor-crosshair',
                        'rgba(255,255,255,0.15) is the crosshair gradient stop; covered by new token.'),
    ('app.css', 3806): ('--theme-pianoroll-resize-handle-stripe',
                        'rgba(255,255,255,0.25) is one of the four stops of the resize-handle stripe gradient; covered by new token.'),
    ('app.css', 3807): ('--theme-pianoroll-resize-handle-stripe',
                        'rgba(255,255,255,0.25) is one of the four stops of the resize-handle stripe gradient; covered by new token.'),
    ('app.css', 3810): ('--theme-pianoroll-resize-handle-stripe',
                        'rgba(255,255,255,0.25) is one of the four stops of the resize-handle stripe gradient; covered by new token.'),
    ('app.css', 3811): ('--theme-pianoroll-resize-handle-stripe',
                        'rgba(255,255,255,0.25) is one of the four stops of the resize-handle stripe gradient; covered by new token.'),
    # Task 2 mechanical: #555566 re-attributes
    ('SyllableSplitter.jsx', 11): ('--theme-text-subtle',
                                   'Hex value #555566 equals --theme-text-subtle derived default; wave color re-attributed.'),
    ('WaveformScrubber.jsx', 12): ('--theme-text-subtle',
                                   'Hex value #555566 equals --theme-text-subtle derived default; text/error color re-attributed.'),
    # Task 2 mechanical: sampler black key
    ('MiniKeyboard.jsx', 96): ('--theme-sampler-key-black',
                               'Pure black (#000) is the black key fill/border; covered by new --theme-sampler-key-black token.'),
}

hits = 0
for m in matches:
    path_frag = (m.get('path') or '').replace('\\', '/').split('/')[-1]
    line = m.get('line')
    entry = PASS3_MAP.get((path_frag, line))
    if entry and m.get('confidence') == 'no-fit':
        tok, rationale = entry
        m['confidence'] = 'high'
        m['proposedTokenName'] = tok
        m['assignmentRule'] = 'catalog-added-pass3'
        m['rationale'] = rationale
        hits += 1

print(f'Pass 3 no-fit -> high: {hits} entries resolved')

# Recompute counts
cc = Counter(m.get('confidence') for m in matches)
data['confidenceCounts'] = {
    'high':           cc.get('high', 0),
    'medium':         cc.get('medium', 0),
    'low':            cc.get('low', 0),
    'no-fit':         cc.get('no-fit', 0),
    'false-positive': cc.get('false-positive', 0),
}
sc = Counter(m.get('subsystem') for m in matches)
data['dispatchStats']['unmatched'] = cc.get('no-fit', 0)
data['dispatchStats']['bySubsystem'] = dict(sc.most_common())
data['_mutatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()

with open(src, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)

print('Done. New confidence counts:', data['confidenceCounts'])
