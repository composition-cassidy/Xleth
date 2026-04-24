import json, datetime
from collections import Counter

src = 'C:/Users/Krasen/Desktop/XLETH/scripts/theming-audit-enriched.json'
with open(src, encoding='utf-8') as f:
    data = json.load(f)

matches = data['matches']
hits = 0

for m in matches:
    path_frag = (m.get('path') or '').replace('\\', '/').split('/')[-1]
    line = m.get('line')
    conf = m.get('confidence')

    if path_frag == 'SyllableSplitter.jsx' and line == 12 and conf == 'no-fit':
        m['confidence'] = 'high'
        m['proposedTokenName'] = '--theme-syllable-splitter-wave-dim'
        m['assignmentRule'] = 'catalog-added-pass4'
        m['rationale'] = 'waveDim color for inactive canvas waveform regions; covered by new --theme-syllable-splitter-wave-dim token.'
        hits += 1

    elif path_frag == 'SyllableSplitter.jsx' and line == 16 and conf == 'no-fit':
        m['confidence'] = 'high'
        m['proposedTokenName'] = '--theme-syllable-splitter-label-fg'
        m['assignmentRule'] = 'catalog-added-pass4'
        m['rationale'] = 'Canvas-painted label text color; covered by new --theme-syllable-splitter-label-fg token.'
        hits += 1

    elif path_frag == 'app.css' and line == 7432 and conf == 'no-fit':
        m['subsystem'] = 'toast'
        m['originalSubsystem'] = 'dialogs-modals'
        m['confidence'] = 'high'
        m['proposedTokenName'] = '--theme-toast-shadow'
        m['assignmentRule'] = 'catalog-added-pass4'
        m['rationale'] = 'Misclassified as dialogs-modals by selector proximity; toast notifications are a semantically distinct subsystem. Covered by new --theme-toast-shadow token.'
        hits += 1

cc = Counter(m.get('confidence') for m in matches)
data['confidenceCounts'] = {k: cc.get(k, 0) for k in ('high', 'medium', 'low', 'no-fit', 'false-positive')}
sc = Counter(m.get('subsystem') for m in matches)
data['dispatchStats']['unmatched'] = cc.get('no-fit', 0)
data['dispatchStats']['bySubsystem'] = dict(sc.most_common())
data['_mutatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()

with open(src, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)

print(f'Pass 4: {hits} entries resolved. New counts:', data['confidenceCounts'])
