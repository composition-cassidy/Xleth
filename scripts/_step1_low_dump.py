import json
with open('C:/Users/Krasen/Desktop/XLETH/scripts/theming-audit-enriched.json', encoding='utf-8') as f:
    data = json.load(f)
lows = [m for m in data['matches'] if m.get('confidence') == 'low']
out = []
out.append(f'Total LOW: {len(lows)}\n')
for i, m in enumerate(lows, 1):
    out.append(f'\n{"="*70}')
    out.append(f' LOW #{i}  {m.get("path")}:{m.get("line")}')
    out.append(f'{"="*70}')
    out.append(f'  matchedText       : {m.get("matchedText")!r}')
    out.append(f'  proposedToken     : {m.get("proposedTokenName")}')
    out.append(f'  subsystem         : {m.get("subsystem")}')
    out.append(f'  elementHint       : {m.get("elementHint")}')
    out.append(f'  rationale         : {m.get("rationale")}')
    out.append(f'  surroundingContext:')
    for line in (m.get('surroundingContext') or '').split('\n'):
        out.append(f'    {line}')
with open('C:/Users/Krasen/Desktop/XLETH/scripts/_step1_low_dump.txt', 'w', encoding='utf-8') as f:
    f.write('\n'.join(out))
print(f'Wrote {len(lows)} LOW entries')
