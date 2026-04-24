"""
Pass 2: Resolve stale no-fit entries whose catalog tokens were added
in Task 2 but the enrichment JSON predates those additions.
"""
import json, datetime
from collections import Counter

src = 'C:/Users/Krasen/Desktop/XLETH/scripts/theming-audit-enriched.json'
with open(src, encoding='utf-8') as f:
    data = json.load(f)

matches = data['matches']

# Mapping: (path_fragment, line, matchedText_upper) -> proposedTokenName
# Only entries where we have a direct catalog-token match.
NEW_COVERAGE = {
    # sampler
    ('MiniKeyboard.jsx', 61, '#2A2A38'):        '--theme-sampler-key-border',
    # timeline bezier handles
    ('FadeBezierEditor.jsx', 123, '#F59E0B'):   '--theme-timeline-bezier-handle-cp1',
    ('FadeBezierEditor.jsx', 124, '#3B82F6'):   '--theme-timeline-bezier-handle-cp2',
    # lip-sync-picker
    ('WaveformScrubber.jsx', 6,   'RGBA(51, 206, 214, 0.15)'): '--theme-lipsync-selection-fill',
    ('WaveformScrubber.jsx', 7,   '#33CED6'):   '--theme-lipsync-handle',
    ('WaveformScrubber.jsx', 8,   '#33CED6'):   '--theme-lipsync-handle',
    ('WaveformScrubber.jsx', 231, 'RGBA(51, 206, 214, 0.35)'): '--theme-lipsync-playback-indicator',
    ('WaveformScrubber.jsx', 232, 'RGBA(51, 206, 214, 0.55)'): '--theme-lipsync-scroll-thumb',
    ('WaveformScrubber.jsx', 269, '#33CED6'):   '--theme-lipsync-handle',
    ('WaveformScrubber.jsx', 270, '#33CED6'):   '--theme-lipsync-handle',
    # project-media
    ('app.css', 4691, 'RGBA(0,0,0,0.5)'):       '--theme-projectmedia-shadow',
    # dialogs-modals — only the 0.6 shadow matches --theme-modal-shadow default
    ('app.css', 7333, 'RGBA(0,0,0,0.6)'):       '--theme-modal-shadow',
}

hits = 0
for m in matches:
    path_frag = (m.get('path') or '').replace('\\', '/').split('/')[-1]
    line = m.get('line')
    raw = (m.get('matchedText') or '').upper().strip()
    tok = NEW_COVERAGE.get((path_frag, line, raw))
    if tok and m.get('confidence') == 'no-fit':
        m['confidence'] = 'high'
        m['proposedTokenName'] = tok
        m['assignmentRule'] = 'catalog-added-pass2'
        m['rationale'] = f'Token {tok} added to catalog in Task 2; hardcoded value now covered.'
        hits += 1

print(f'Pass 2 stale-no-fit -> high: {hits} entries resolved')

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
