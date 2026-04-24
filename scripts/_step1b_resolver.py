"""
Build a comprehensive Default-theme token resolver from:
  - BASE_DEFAULTS (ui/src/theming/tokens/base.ts)
  - derivation anchors (ui/src/theming/tokens/__tests__/derivation.test.ts ANCHORS
    + the formula tokens with explicit hex assertions in that file)
  - catalog.ts explicit() and ref() calls
  - shipped/xleth-default.json (only has explicit overrides)

Output: JSON map { tokenName: resolvedValue } written to _step1b_tokens.json.
"""
import json, re, colorsys

def hex_to_rgb(h):
    h = h.lstrip('#')
    if len(h) == 3: h = ''.join(c*2 for c in h)
    return tuple(int(h[i:i+2], 16) for i in (0,2,4))

def rgb_to_hex(rgb):
    return '#' + ''.join(f'{max(0,min(255,round(c))):02X}' for c in rgb)

def shift_hsl(hexstr, dL=0.0, dS=0.0, dH=0.0):
    r,g,b = hex_to_rgb(hexstr)
    h,l,s = colorsys.rgb_to_hls(r/255, g/255, b/255)
    # dL and dS in percent-units (0..100 scale in spec), colorsys uses 0..1
    L = max(0.0, min(1.0, l + dL/100))
    S = max(0.0, min(1.0, s + dS/100))
    H = ((h*360 + dH) % 360) / 360
    r,g,b = colorsys.hls_to_rgb(H, L, S)
    return rgb_to_hex((r*255, g*255, b*255))

def with_alpha(hexstr, a):
    r,g,b = hex_to_rgb(hexstr)
    return f'rgba({r}, {g}, {b}, {a})'


CATALOG    = 'C:/Users/Krasen/Desktop/XLETH/ui/src/theming/tokens/catalog.ts'
DERIV_TEST = 'C:/Users/Krasen/Desktop/XLETH/ui/src/theming/tokens/__tests__/derivation.test.ts'
DERIV_SRC  = 'C:/Users/Krasen/Desktop/XLETH/ui/src/theming/tokens/derivation.ts'

# 1. Base defaults (hardcoded)
resolved = {
    '--theme-bg-primary': '#0A0A0F',
    '--theme-bg-surface': '#1A1A24',
    '--theme-accent':     '#33CED6',
    '--theme-text':       '#E8E8ED',
    '--theme-danger':     '#FF4757',
}

# 1b. Derived formula tokens — computed directly from base
ACC = resolved['--theme-accent']
BGP = resolved['--theme-bg-primary']
BGS = resolved['--theme-bg-surface']
TXT = resolved['--theme-text']
resolved['--theme-bg-tertiary'] = shift_hsl(BGP, dL=6)
resolved['--theme-bg-hover']    = shift_hsl(BGS, dL=4)
resolved['--theme-bg-active']   = shift_hsl(BGS, dL=8)
resolved['--theme-border-strong'] = with_alpha(TXT, 0.25)
resolved['--theme-border-focus']  = ACC
resolved['--theme-accent-active'] = shift_hsl(ACC, dL=10)
resolved['--theme-panel-mixer']     = ACC
resolved['--theme-panel-timeline']  = shift_hsl(ACC, dH=60)
resolved['--theme-panel-pianoroll'] = shift_hsl(ACC, dH=120)
resolved['--theme-panel-preview']   = shift_hsl(ACC, dH=180)
resolved['--theme-panel-grid']      = shift_hsl(ACC, dH=240)
resolved['--theme-panel-node']      = shift_hsl(ACC, dH=300)
resolved['--theme-info']            = ACC
resolved['--theme-text-inverse']    = BGP

# 2. Derivation anchors (these are what derivedFormula() produces)
with open(DERIV_TEST, encoding='utf-8') as f:
    dt = f.read()
# Pull the ANCHORS object
anchors_block = re.search(r"const ANCHORS[^{]*\{(.*?)\};", dt, re.DOTALL)
if anchors_block:
    for m in re.finditer(r"'(--theme-[a-z0-9-]+)':\s*'([^']+)'", anchors_block.group(1)):
        resolved[m.group(1)] = m.group(2)

# Also capture values that test assertions pin (eqHex)
for m in re.finditer(r"eqHex\(d\['(--theme-[a-z0-9-]+)'\],\s*'(#[0-9a-fA-F]+)'\)", dt):
    resolved.setdefault(m.group(1), m.group(2))
# toBe('rgba(...)')
for m in re.finditer(r"d\['(--theme-[a-z0-9-]+)'\]\)\.toBe\('([^']+)'\)", dt):
    resolved.setdefault(m.group(1), m.group(2))

# 3. Catalog explicit() and ref()
with open(CATALOG, encoding='utf-8') as f:
    cat = f.read()

# explicit(name, value, ...)  -- value is a string literal
for m in re.finditer(
    r"explicit\(\s*'(--theme-[a-z0-9-]+)'\s*,\s*'([^']+)'",
    cat
):
    resolved[m.group(1)] = m.group(2)

# ref(name, target, ...)  -- store as link, resolve later
refs = {}
for m in re.finditer(
    r"ref\(\s*'(--theme-[a-z0-9-]+)'\s*,\s*'(--theme-[a-z0-9-]+)'",
    cat
):
    refs[m.group(1)] = m.group(2)

# alias(name, target, ...)
aliases = {}
for m in re.finditer(
    r"alias\(\s*'(--theme-[a-z0-9-]+)'\s*,\s*'(--theme-[a-z0-9-]+)'",
    cat
):
    aliases[m.group(1)] = m.group(2)

# Formula tokens not in ANCHORS (e.g. bg-tertiary, bg-hover, bg-active, border-strong,
# border-focus, info, accent-active, panel-*). Parse derivation.ts assertions if possible.
with open(DERIV_SRC, encoding='utf-8') as f:
    dsrc = f.read()
# The derivation.ts file has inline //-comments with target values. Grab
# "→ #XXXXXX" tags.
for m in re.finditer(r"(--theme-[a-z0-9-]+)[^\n]*?\u2192\s*(#[0-9a-fA-F]{3,8})", dsrc):
    resolved.setdefault(m.group(1), m.group(2))
for m in re.finditer(r"(--theme-[a-z0-9-]+)[^\n]*?->\s*(#[0-9a-fA-F]{3,8})", dsrc):
    resolved.setdefault(m.group(1), m.group(2))

# Resolve refs (up to 10 hops)
def deref(tok, depth=0):
    if depth > 10: return None
    if tok in resolved:
        return resolved[tok]
    if tok in refs:
        return deref(refs[tok], depth+1)
    if tok in aliases:
        return deref(aliases[tok], depth+1)
    return None

changed = True
while changed:
    changed = False
    for k in list(refs.keys()) + list(aliases.keys()):
        if k not in resolved:
            v = deref(refs.get(k) or aliases.get(k))
            if v is not None:
                resolved[k] = v
                changed = True

with open('C:/Users/Krasen/Desktop/XLETH/scripts/_step1b_tokens.json', 'w', encoding='utf-8') as f:
    json.dump(resolved, f, indent=2, ensure_ascii=False, sort_keys=True)

total_tok_call = len(re.findall(r"(?:base|derivedFormula|explicit|ref|alias)\(\s*'(--theme-[a-z0-9-]+)'", cat))
print(f'Resolved {len(resolved)} tokens out of {total_tok_call} catalog calls')
missing = []
for m in re.finditer(
    r"(?:base|derivedFormula|explicit|ref|alias)\(\s*'(--theme-[a-z0-9-]+)'",
    cat
):
    if m.group(1) not in resolved:
        missing.append(m.group(1))
print(f'Unresolved ({len(set(missing))}): {sorted(set(missing))[:15]}')
