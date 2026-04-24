import json
from collections import Counter

with open('C:/Users/Krasen/Desktop/XLETH/scripts/theming-audit-enriched.json', encoding='utf-8') as f:
    data = json.load(f)
matches = data['matches']

ORDER = [
    ('Foundations',            ['base', 'borders', 'text', 'semantic']),
    ('Global UI',              ['buttons', 'dialogs-modals', 'context-menus', 'menu-bar-toolbar', 'transport-bar', 'top-toolbar', 'toast']),
    ('Panel chrome',           ['panel-chrome', 'dock-snap', 'panel-types']),
    ('Workspace low',          ['sample-selector', 'project-media', 'pattern-list', 'preview-player']),
    ('Workspace medium',       ['timeline', 'mixer']),
    ('Stock effects shared',   ['stock-effects.shared']),
    ('Stock effects each',     ['stock-effects.eq', 'stock-effects.dynamics', 'stock-effects.filter', 'stock-effects.modulation', 'stock-effects.time', 'stock-effects.distortion']),
    ('Workspace high',         ['piano-roll', 'sampler', 'grid-editor']),
    ('Specialized editors',    ['node-editor', 'syllable-splitter', 'lip-sync-picker']),
    ('Labels',                 ['labels']),
]

sub_count = Counter(m.get('subsystem') for m in matches)
# Also break down per subsystem by tier
def tier_counts(sub):
    c = Counter(m.get('confidence') for m in matches if m.get('subsystem') == sub)
    return c.get('high', 0), c.get('medium', 0), c.get('low', 0), c.get('false-positive', 0)

lines = []
lines.append(f'{"Step":4s}  {"Subsystem":24s}  {"Total":>6s}  {"HIGH":>5s}  {"MED":>5s}  {"LOW":>5s}  {"FP":>4s}')
lines.append('-' * 70)

step = 0
grand_total = 0
grand_counts = [0, 0, 0, 0]
unknown_subs = set(sub_count.keys())
for group_name, subs in ORDER:
    lines.append(f'\n[{group_name}]')
    for s in subs:
        if s in unknown_subs:
            unknown_subs.discard(s)
        n = sub_count.get(s, 0)
        h, me, lo, fp = tier_counts(s)
        step += 1
        grand_total += n
        grand_counts = [grand_counts[i] + x for i, x in enumerate([h, me, lo, fp])]
        skip_mark = '  (SKIP — 0 matches)' if n == 0 else ''
        lines.append(f'{step:>3d}.  {s:24s}  {n:>6d}  {h:>5d}  {me:>5d}  {lo:>5d}  {fp:>4d}{skip_mark}')

lines.append('-' * 70)
lines.append(f'{"TOTAL":28s}  {grand_total:>6d}  {grand_counts[0]:>5d}  {grand_counts[1]:>5d}  {grand_counts[2]:>5d}  {grand_counts[3]:>4d}')

if unknown_subs:
    lines.append(f'\nWARNING — subsystems in enriched JSON not in migration order: {sorted(unknown_subs)}')
    for s in sorted(unknown_subs):
        lines.append(f'   {s}: {sub_count[s]} matches')

with open('C:/Users/Krasen/Desktop/XLETH/scripts/_step1_order.txt', 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))
print('\n'.join(lines))
