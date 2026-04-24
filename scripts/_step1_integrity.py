"""
Step 1.1 integrity checks for Phase 0 Migration.
Prints a pass/fail report for each of the 5 checks.
"""
import json, re
from collections import Counter, defaultdict

ENRICHED = 'C:/Users/Krasen/Desktop/XLETH/scripts/theming-audit-enriched.json'
CATALOG  = 'C:/Users/Krasen/Desktop/XLETH/ui/src/theming/tokens/catalog.ts'

# ── Parse catalog.ts ─────────────────────────────────────────────────────────
with open(CATALOG, encoding='utf-8') as f:
    cat_src = f.read()

# Token names: any of base/derivedFormula/explicit/ref/alias("--theme-x", ...)
TOKEN_CALL = re.compile(
    r"(?:base|derivedFormula|explicit|ref|alias)\(\s*'(--theme-[a-z0-9-]+)'",
    re.IGNORECASE
)
tokens = TOKEN_CALL.findall(cat_src)
# Each token is (name). Also capture subsystem from the call if possible.
# catalog call signatures (based on catalog.ts):
#   base(name, kind='color', category='Foundations', subsystem='base')
#   derivedFormula(name, capability, category, subsystem)
#   explicit(name, value, capability, category, subsystem)
#   ref(name, target, capability, category, subsystem)
#   alias(name, target, ...)  -- skip subsystem parse, alias is an indirection
# Use a broader regex to capture the entire call and extract the last string arg as subsystem.
TOKEN_FULL = re.compile(
    r"(base|derivedFormula|explicit|ref|alias)\(([^)]*)\)",
    re.DOTALL
)
token_to_subsystem = {}
for m in TOKEN_FULL.finditer(cat_src):
    call = m.group(2)
    # pull the token name
    mn = re.search(r"'(--theme-[a-z0-9-]+)'", call, re.IGNORECASE)
    if not mn:
        continue
    tname = mn.group(1)
    # find all string literals in the call; subsystem is the last one (by convention)
    strings = re.findall(r"'([^']*)'", call)
    if len(strings) >= 2:
        # last string is subsystem (for base/derivedFormula/explicit/ref); for alias, unclear
        token_to_subsystem[tname] = strings[-1]
    else:
        token_to_subsystem[tname] = None

token_names = set(tokens)

# ── Parse SUBSYSTEMS list ────────────────────────────────────────────────────
SUBSYS_BLOCK = re.search(r"SUBSYSTEMS[^\[]*\[(.*?)\n\];", cat_src, re.DOTALL)
subsystem_keys = set()
subsystem_aliases = {}  # alias -> canonical key
if SUBSYS_BLOCK:
    for m in re.finditer(r"key:\s*'([a-z0-9.-]+)'", SUBSYS_BLOCK.group(1), re.IGNORECASE):
        subsystem_keys.add(m.group(1))
    # parse aliases: { key: 'x', ..., aliases: ['y', 'z'] }
    for m in re.finditer(r"key:\s*'([a-z0-9.-]+)'[^}]*aliases:\s*\[([^\]]*)\]", SUBSYS_BLOCK.group(1), re.IGNORECASE|re.DOTALL):
        canon = m.group(1)
        for a in re.findall(r"'([^']+)'", m.group(2)):
            subsystem_aliases[a] = canon

# ── Load enriched audit ─────────────────────────────────────────────────────
with open(ENRICHED, encoding='utf-8') as f:
    data = json.load(f)
matches = data['matches']
cc = data.get('confidenceCounts') or {}

# ────────────────────────────────────────────────────────────────────────────
print('=' * 70)
print('  STEP 1.1 — INTEGRITY CHECKS')
print('=' * 70)
print()
print(f'Catalog: {len(token_names)} unique tokens, {len(subsystem_keys)} subsystems')
print(f'Enriched: {len(matches)} matches')
print()

# Check 1: 584 entries
print('[Check 1] Enriched audit has 584 entries')
ok1 = len(matches) == 584
print(f'   Actual: {len(matches)}  ->  {"PASS" if ok1 else "FAIL"}')
print()

# Check 2: every proposedTokenName exists in catalog
print('[Check 2] Every non-null proposedTokenName exists in catalog')
missing_tokens = defaultdict(list)
for m in matches:
    tok = m.get('proposedTokenName')
    if tok and tok not in token_names:
        missing_tokens[tok].append(f"{m.get('path')}:{m.get('line')}")
ok2 = not missing_tokens
if ok2:
    print('   All proposed tokens exist in catalog.  ->  PASS')
else:
    print(f'   {len(missing_tokens)} missing token(s):')
    for tok, locs in missing_tokens.items():
        print(f'     {tok}  ({len(locs)} matches, sample: {locs[0]})')
    print('   ->  FAIL')
print()

# Check 3: every proposedTokenName's subsystem aligns with match subsystem
# Universal subsystems that are allowed on any match regardless of match.subsystem
UNIVERSAL = {'base', 'borders', 'text', 'semantic', 'derived', 'labels'}
print('[Check 3] Match.subsystem aligns with token.subsystem (universals excepted)')
misaligned = []
for m in matches:
    tok = m.get('proposedTokenName')
    if not tok:
        continue
    tok_sub = token_to_subsystem.get(tok)
    match_sub = m.get('subsystem')
    if tok_sub is None:
        continue  # couldn't parse — skip
    if tok_sub in UNIVERSAL:
        continue  # token from a cross-cutting subsystem is always OK
    if match_sub == tok_sub:
        continue
    # allow alias resolution
    if subsystem_aliases.get(match_sub) == tok_sub:
        continue
    misaligned.append((m.get('path'), m.get('line'), match_sub, tok, tok_sub))
ok3 = not misaligned
if ok3:
    print('   All matches align with their token subsystem.  ->  PASS')
else:
    print(f'   {len(misaligned)} misaligned:')
    # group
    grp = Counter((x[2], x[4]) for x in misaligned)
    for (ms, ts), cnt in sorted(grp.items(), key=lambda x: -x[1])[:10]:
        print(f'     match.subsystem={ms}  token.subsystem={ts}  ({cnt} matches)')
    print('   ->  FAIL')
print()

# Check 4: tier counts
print('[Check 4] Tier counts match expected (228 HIGH, 335 MEDIUM, 12 LOW, 0 NO-FIT, 9 FALSE-POSITIVE)')
expected = {'high': 228, 'medium': 335, 'low': 12, 'no-fit': 0, 'false-positive': 9}
actual = Counter(m.get('confidence') for m in matches)
ok4 = all(actual.get(k, 0) == v for k, v in expected.items())
for k, v in expected.items():
    a = actual.get(k, 0)
    mark = 'OK' if a == v else 'MISMATCH'
    print(f'   {k:16s}: expected {v:4d}  actual {a:4d}  [{mark}]')
print(f'   ->  {"PASS" if ok4 else "FAIL"}')
print()

# Check 5: confidenceCounts in JSON header matches actual
print('[Check 5] JSON header confidenceCounts matches actual tier distribution')
ok5 = all(cc.get(k, 0) == actual.get(k, 0) for k in actual)
if ok5:
    print('   Header is consistent with match data.  ->  PASS')
else:
    print(f'   Header mismatch. Header: {cc}. Actual: {dict(actual)}')
    print('   ->  FAIL')
print()

print('=' * 70)
all_pass = ok1 and ok2 and ok3 and ok4 and ok5
print(f'  OVERALL: {"ALL PASS" if all_pass else "INTEGRITY FAILURES FOUND"}')
print('=' * 70)
