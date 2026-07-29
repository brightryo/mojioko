"""Rewrite a TTF's `name` table to a namespaced family (REQ-0275 §2).

Usage:
    python scripts/rename-font-family.py --in <src.ttf> --out <dst.ttf> \\
        --family <FAMILY> --full <FULL> --postscript <POSTSCRIPT> [--typographic-family <TYPFAM>]

Rewrites four Windows-platform (platformID=3, platEncID=1) name records:
    ID  1 → --family              (Family)
    ID  4 → --full                (Full font name)
    ID  6 → --postscript          (PostScript name — ASCII, no whitespace, ≤63 chars)
    ID 16 → --typographic-family  (defaults to --family; used by families with ≥4 weights)

Records on other platforms (Mac, Unicode) are left untouched — libass and
DirectWrite match against the Windows platform record.  Glyph outlines,
`hmtx`, `cmap`, `head`, `hhea`, `OS/2` and every other table are untouched
per REQ-0275 §0-3.

The script fails loudly if the PostScript name violates its constraints
(ASCII printable, no whitespace, ≤63 chars) — this keeps a misconfigured
build from silently shipping a font that DirectWrite refuses to load.

Used by REQ-0275 §2 to produce `fonts-v3` from the pre-REQ-0275 assets
(shipped Noto Sans JP static weights + fonts-v2 downloadable TTFs).  See
SPECIFICATION §24.3.1 for the naming convention and recipe.
"""
from __future__ import annotations
import argparse, os, sys
from fontTools.ttLib import TTFont

def validate_postscript(name: str) -> None:
    if not name:
        raise ValueError('postscript name is empty')
    if len(name) > 63:
        raise ValueError(f'postscript name too long ({len(name)} > 63): {name!r}')
    for ch in name:
        code = ord(ch)
        if code < 0x21 or code > 0x7E:
            raise ValueError(f'postscript name has non-ASCII-printable char {ch!r} (U+{code:04X})')
    for bad in ' \t\n\r()[]{}<>/%':
        if bad in name:
            raise ValueError(f'postscript name contains forbidden char {bad!r}: {name!r}')

def rewrite(src: str, dst: str, family: str, full: str, postscript: str, typ_family: str | None) -> None:
    validate_postscript(postscript)
    typ = typ_family if typ_family is not None else family
    font = TTFont(src)
    name = font['name']
    # Track which IDs we updated so we can log a summary.
    updated = set()
    for record in name.names:
        if record.platformID != 3:      # Only touch Windows (Microsoft) records
            continue
        if record.platEncID != 1:       # Only UCS-2 (BMP)
            continue
        if record.nameID == 1:   newv, key = family, 'family(1)'
        elif record.nameID == 4: newv, key = full, 'full(4)'
        elif record.nameID == 6: newv, key = postscript, 'postscript(6)'
        elif record.nameID == 16: newv, key = typ, 'typFam(16)'
        else: continue
        record.string = newv.encode('utf-16-be')
        updated.add(key)
    # If typographic family (ID 16) wasn't in the original name table, add it.
    # We always add ID 16 so that families with weight variants (like Noto Sans JP)
    # keep grouping properly across weights in font-picking APIs.
    if 'typFam(16)' not in updated:
        # Use setName which handles record creation cleanly.
        name.setName(typ, 16, 3, 1, 0x409)
        updated.add('typFam(16)+created')
    font.save(dst)
    print(f'wrote {dst}')
    print(f'  updated name IDs: {sorted(updated)}')
    print(f'  family (1)        : {family!r}')
    print(f'  full   (4)        : {full!r}')
    print(f'  postscript (6)    : {postscript!r}')
    print(f'  typographic (16)  : {typ!r}')

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--in', dest='src', required=True)
    ap.add_argument('--out', dest='dst', required=True)
    ap.add_argument('--family', required=True)
    ap.add_argument('--full', required=True)
    ap.add_argument('--postscript', required=True)
    ap.add_argument('--typographic-family', default=None)
    args = ap.parse_args()
    if not os.path.exists(args.src):
        print(f'error: source not found: {args.src}', file=sys.stderr); return 2
    rewrite(args.src, args.dst, args.family, args.full, args.postscript, args.typographic_family)
    return 0

if __name__ == '__main__':
    sys.exit(main())
