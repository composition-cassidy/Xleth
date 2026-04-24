"""
Task A: Draw 30 MEDIUM-confidence matches weighted by subsystem match count,
with at least 1 per subsystem that has any MEDIUM matches.
Resolve each proposed token to its Default-theme value.
"""
import json, random, re, math
from collections import Counter, defaultdict

ENRICHED = 'C:/Users/Krasen/Desktop/XLETH/scripts/theming-audit-enriched.json'
CATALOG  = 'C:/Users/Krasen/Desktop/XLETH/ui/src/theming/tokens/catalog.ts'
TOKENS   = 'C:/Users/Krasen/Desktop/XLETH/scripts/_step1b_tokens.json'

random.seed(42)

# ── Load enriched ────────────────────────────────────────────────────────────
with open(ENRICHED, encoding='utf-8') as f:
    data = json.load(f)
matches = data['matches']
meds = [m for m in matches if m.get('confidence') == 'medium']

# ── Group MEDIUMs by subsystem ──────────────────────────────────────────────
by_sub = defaultdict(list)
for m in meds:
    by_sub[m.get('subsystem')].append(m)

total_med = len(meds)
print(f'Total MEDIUM: {total_med}')
print(f'Subsystems with MEDIUMs: {len(by_sub)}')

# ── Weighted allocation with floor=1 per non-empty subsystem ────────────────
N = 30
subs = sorted(by_sub.keys(), key=lambda s: -len(by_sub[s]))
# First pass: 1 per subsystem
alloc = {s: 1 for s in subs}
remaining = N - len(subs)
if remaining < 0:
    # Too many subsystems; just take top-N by count
    subs = subs[:N]
    alloc = {s: 1 for s in subs}
    remaining = 0

# Distribute remaining proportionally to subsystem size
sizes = {s: len(by_sub[s]) for s in subs}
total_size = sum(sizes.values())
# Compute extra allocations
extras = []
for s in subs:
    extra = (sizes[s] / total_size) * N - 1  # subtract the floor of 1
    if extra > 0:
        extras.append((s, extra))
extras.sort(key=lambda x: -x[1])
# Give integer extras greedily
i = 0
while remaining > 0 and extras:
    s, _ = extras[i % len(extras)]
    # don't exceed available count in subsystem
    if alloc[s] < sizes[s]:
        alloc[s] += 1
        remaining -= 1
    i += 1
    if i > 10000: break

# ── Sample ──────────────────────────────────────────────────────────────────
sample = []
for s in subs:
    picks = random.sample(by_sub[s], min(alloc[s], len(by_sub[s])))
    for p in picks:
        sample.append(p)

# Trim/pad to exactly 30
if len(sample) > N:
    sample = sample[:N]
elif len(sample) < N:
    # pad from largest subsystems
    pool = [m for s in subs for m in by_sub[s] if m not in sample]
    random.shuffle(pool)
    sample.extend(pool[:N - len(sample)])

# ── Load comprehensive resolver ──────────────────────────────────────────────
with open(TOKENS, encoding='utf-8') as f:
    shipped_tokens = json.load(f)
print(f'Tokens resolved: {len(shipped_tokens)}')

def resolve(tok):
    if not tok: return '(none)'
    return shipped_tokens.get(tok, '(unresolved)')

# ── Write output ────────────────────────────────────────────────────────────
out = []
out.append(f'Total MEDIUM: {total_med}')
out.append(f'Sample size: {len(sample)}')
out.append(f'Allocation: ' + ', '.join(f'{s}={alloc[s]}' for s in subs if alloc[s] > 0))
out.append('')

for i, m in enumerate(sample, 1):
    tok = m.get('proposedTokenName')
    resolved = resolve(tok)
    out.append(f'\n{"="*72}')
    out.append(f' MED #{i}  {m.get("path")}:{m.get("line")}')
    out.append(f'{"="*72}')
    out.append(f'  matchedText       : {m.get("matchedText")!r}')
    out.append(f'  proposedToken     : {tok}')
    out.append(f'  tokenResolvesTo   : {resolved}')
    out.append(f'  subsystem         : {m.get("subsystem")}')
    out.append(f'  elementHint       : {m.get("elementHint")}')
    out.append(f'  rationale         : {m.get("rationale")}')
    out.append(f'  surroundingContext:')
    for line in (m.get('surroundingContext') or '').split('\n'):
        out.append(f'    {line}')

with open('C:/Users/Krasen/Desktop/XLETH/scripts/_step1b_medium_sample.txt', 'w', encoding='utf-8') as f:
    f.write('\n'.join(out))

print(f'Wrote {len(sample)} MEDIUM entries')
