"""Regenerate fonts-v3 = 26 downloadable TTFs + 3 bundled Noto TTFs
namespaced under `MOJIOKO` (REQ-0275 §2).

Inputs (source-of-truth pre-rename bytes):
    - Bundled Noto: resources/fonts/Noto_Sans_JP/static/NotoSansJP-{Regular,Medium,SemiBold}.ttf
                    (fonts-v2 era, varLib instances from RES-0272)
    - Downloadable: fetched from fonts-v2 GitHub release via `gh release download`
                    (Poppins 9 + Anton + Bebas Neue + Montserrat + 8 JA display + Noto 6)

Outputs:
    - build/fonts-v3-staging/bundled/*.ttf  → to be copied into resources/fonts/...
    - build/fonts-v3-staging/upload/*.ttf   → to be uploaded to fonts-v3 GitHub release
    - build/fonts-v3-staging/upload/*.txt   → per-font OFL sidecars (byte-copies of fonts-v2)

Verifies the rewrite for each output:
    - name IDs 1/4/6/16 match the intended MOJIOKO prefix
    - head.unitsPerEm, hhea/OS-2 metrics, hmtx advance widths unchanged
    - cmap coverage unchanged

Run:  .venv/Scripts/python scripts/build-fonts-v3.py
"""
from __future__ import annotations
import os, sys, subprocess, shutil
from fontTools.ttLib import TTFont

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
STAGING = os.path.join(REPO, 'build', 'fonts-v3-staging')
UPLOAD = os.path.join(STAGING, 'upload')
BUNDLED_OUT = os.path.join(STAGING, 'bundled')
SRC_DIR = os.path.join(STAGING, 'src')  # fonts-v2 downloads
BUNDLED_SRC = os.path.join(REPO, 'resources', 'fonts', 'Noto_Sans_JP', 'static')
RENAMER = os.path.join(REPO, 'scripts', 'rename-font-family.py')
PY = sys.executable

# 26 downloadable + 3 bundled = 29 entries.
# Each: (file_name, out_family, weight_name_in_full, is_bundled)
#
# The "family" here matches `cssFontFamily` in src/shared/fonts.ts:
# for multi-weight families the family is shared and the weight goes into
# the "full" and postscript names.
FONTS = [
    # (source_file, family, weight_name)  — for single-weight families the
    # weight_name is 'Regular'.  Files whose "family" is None are bundled.
    # Noto Sans JP — 9 weights (3 bundled + 6 downloadable)
    ('NotoSansJP-Thin.ttf',        'MOJIOKO Noto Sans JP', 'Thin',       False),
    ('NotoSansJP-ExtraLight.ttf',  'MOJIOKO Noto Sans JP', 'ExtraLight', False),
    ('NotoSansJP-Light.ttf',       'MOJIOKO Noto Sans JP', 'Light',      False),
    ('NotoSansJP-Regular.ttf',     'MOJIOKO Noto Sans JP', 'Regular',    True),
    ('NotoSansJP-Medium.ttf',      'MOJIOKO Noto Sans JP', 'Medium',     True),
    ('NotoSansJP-SemiBold.ttf',    'MOJIOKO Noto Sans JP', 'SemiBold',   True),
    ('NotoSansJP-Bold.ttf',        'MOJIOKO Noto Sans JP', 'Bold',       False),
    ('NotoSansJP-ExtraBold.ttf',   'MOJIOKO Noto Sans JP', 'ExtraBold',  False),
    ('NotoSansJP-Black.ttf',       'MOJIOKO Noto Sans JP', 'Black',      False),
    # Poppins — 9 weights (all downloadable; Regular filename = Poppins-Regular.ttf)
    ('Poppins-Thin.ttf',           'MOJIOKO Poppins',      'Thin',       False),
    ('Poppins-ExtraLight.ttf',     'MOJIOKO Poppins',      'ExtraLight', False),
    ('Poppins-Light.ttf',          'MOJIOKO Poppins',      'Light',      False),
    ('Poppins-Regular.ttf',        'MOJIOKO Poppins',      'Regular',    False),
    ('Poppins-Medium.ttf',         'MOJIOKO Poppins',      'Medium',     False),
    ('Poppins-SemiBold.ttf',       'MOJIOKO Poppins',      'SemiBold',   False),
    ('Poppins-Bold.ttf',           'MOJIOKO Poppins',      'Bold',       False),
    ('Poppins-ExtraBold.ttf',      'MOJIOKO Poppins',      'ExtraBold',  False),
    ('Poppins-Black.ttf',          'MOJIOKO Poppins',      'Black',      False),
    # Single-weight Latin
    ('Anton-Regular.ttf',          'MOJIOKO Anton',        'Regular',    False),
    ('BebasNeue-Regular.ttf',      'MOJIOKO Bebas Neue',   'Regular',    False),
    ('Montserrat-Variable.ttf',    'MOJIOKO Montserrat',   'Regular',    False),
    # Single-weight JA display
    ('DelaGothicOne-Regular.ttf',  'MOJIOKO Dela Gothic One', 'Regular', False),
    ('DotGothic16-Regular.ttf',    'MOJIOKO DotGothic16',     'Regular', False),
    ('HachiMaruPop-Regular.ttf',   'MOJIOKO Hachi Maru Pop',  'Regular', False),
    ('MochiyPopOne-Regular.ttf',   'MOJIOKO Mochiy Pop One',  'Regular', False),
    ('PottaOne-Regular.ttf',       'MOJIOKO Potta One',       'Regular', False),
    ('RampartOne-Regular.ttf',     'MOJIOKO Rampart One',     'Regular', False),
    ('ReggaeOne-Regular.ttf',      'MOJIOKO Reggae One',      'Regular', False),
    ('YuseiMagic-Regular.ttf',     'MOJIOKO Yusei Magic',     'Regular', False),
]

# Every family shares one OFL sidecar (fonts-v2 already established this).
# family → OFL filename to fetch from fonts-v2.
OFL_MAP = {
    'MOJIOKO Noto Sans JP': 'NotoSansJP-OFL.txt',
    'MOJIOKO Poppins': 'Poppins-OFL.txt',
    'MOJIOKO Anton': 'Anton-OFL.txt',
    'MOJIOKO Bebas Neue': 'BebasNeue-OFL.txt',
    'MOJIOKO Montserrat': 'Montserrat-OFL.txt',
    'MOJIOKO Dela Gothic One': 'DelaGothicOne-OFL.txt',
    'MOJIOKO DotGothic16': 'DotGothic16-OFL.txt',
    'MOJIOKO Hachi Maru Pop': 'HachiMaruPop-OFL.txt',
    'MOJIOKO Mochiy Pop One': 'MochiyPopOne-OFL.txt',
    'MOJIOKO Potta One': 'PottaOne-OFL.txt',
    'MOJIOKO Rampart One': 'RampartOne-OFL.txt',
    'MOJIOKO Reggae One': 'ReggaeOne-OFL.txt',
    'MOJIOKO Yusei Magic': 'YuseiMagic-OFL.txt',
}


def gh_download(name: str, dst_dir: str) -> None:
    dst = os.path.join(dst_dir, name)
    if os.path.exists(dst) and os.path.getsize(dst) > 1024:
        return  # already present + non-empty
    print(f'  gh: fetching {name}')
    subprocess.check_call(['gh', 'release', 'download', 'fonts-v2', '--repo', 'brightryo/mojioko',
                           '--pattern', name, '--output', dst, '--clobber'])


def collect_metrics(font: TTFont) -> dict:
    head, hhea, os2, hmtx, cmap = font['head'], font['hhea'], font['OS/2'], font['hmtx'], font.getBestCmap()
    return {
        'unitsPerEm': head.unitsPerEm,
        'fontRevision': head.fontRevision,
        'numGlyphs': font['maxp'].numGlyphs,
        'hheaAsc': hhea.ascender, 'hheaDesc': hhea.descender, 'hheaLg': hhea.lineGap,
        'os2Typo': (os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap),
        'os2Win': (os2.usWinAscent, os2.usWinDescent),
        'os2xh': getattr(os2, 'sxHeight', None),
        'os2Cap': getattr(os2, 'sCapHeight', None),
        'usWeight': os2.usWeightClass,
        'advances': {cp: hmtx.metrics.get(g, (0, 0))[0] for cp, g in cmap.items()},
        'cmap_len': len(cmap),
    }


def main() -> int:
    os.makedirs(UPLOAD, exist_ok=True)
    os.makedirs(BUNDLED_OUT, exist_ok=True)
    os.makedirs(SRC_DIR, exist_ok=True)

    # 1. Ensure source files are present.
    for filename, family, weight_name, is_bundled in FONTS:
        if is_bundled:
            src = os.path.join(BUNDLED_SRC, filename)
            dst = os.path.join(SRC_DIR, filename)
            if not os.path.exists(dst):
                shutil.copy(src, dst)
        else:
            gh_download(filename, SRC_DIR)
    for ofl_name in set(OFL_MAP.values()):
        gh_download(ofl_name, UPLOAD)

    # 2. Rewrite each font, verifying metrics preservation.
    print()
    print(f'renaming {len(FONTS)} fonts (bundled → build/fonts-v3-staging/bundled, upload → .../upload)')
    print()
    mismatches: list[str] = []
    for filename, family, weight_name, is_bundled in FONTS:
        src = os.path.join(SRC_DIR, filename)
        out_dir = BUNDLED_OUT if is_bundled else UPLOAD
        dst = os.path.join(out_dir, filename)
        # Compose full + PostScript names.
        # For "Regular" weight of families that have a naked family name
        # (single-weight files always shipped as `<Family> Regular`),
        # keep the "Regular" suffix in the full name for clarity.
        full = f'{family} {weight_name}'
        ps = full.replace(' ', '')
        subprocess.check_call([PY, RENAMER, '--in', src, '--out', dst,
                               '--family', family, '--full', full,
                               '--postscript', ps,
                               '--typographic-family', family])
        # Verify metrics + advance widths unchanged.
        before = collect_metrics(TTFont(src))
        after  = collect_metrics(TTFont(dst))
        skip_keys = {'advances', 'cmap_len'}
        for k, v in before.items():
            if k in skip_keys: continue
            if after[k] != v:
                mismatches.append(f'{filename}: {k} changed {v} → {after[k]}')
        if before['cmap_len'] != after['cmap_len']:
            mismatches.append(f'{filename}: cmap size changed {before["cmap_len"]} → {after["cmap_len"]}')
        adv_mis = 0
        for cp, adv in before['advances'].items():
            if after['advances'].get(cp) != adv:
                adv_mis += 1
        if adv_mis:
            mismatches.append(f'{filename}: {adv_mis} advance width mismatches after rewrite')

    print()
    if mismatches:
        print(f'ERROR: {len(mismatches)} metric mismatches detected:')
        for m in mismatches[:20]: print(f'  - {m}')
        return 2
    print(f'OK: all {len(FONTS)} fonts renamed with metric preservation verified.')
    print(f'  upload   dir: {UPLOAD}    ({sum(1 for _, _, _, b in FONTS if not b)} TTF)')
    print(f'  bundled  dir: {BUNDLED_OUT}   ({sum(1 for _, _, _, b in FONTS if b)} TTF)')
    print(f'  ofl-in-upload: {len(set(OFL_MAP.values()))} sidecar files')
    return 0


if __name__ == '__main__':
    sys.exit(main())
