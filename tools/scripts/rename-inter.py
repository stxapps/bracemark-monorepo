#!/usr/bin/env python3
"""Rename Inter's internal font name to the family "Inter".

Upstream `InterVariable.ttf` reports its family as **"Inter Variable"** (name
ID 1). The `expo-font` config plugin embeds a font on iOS under its *internal*
family name and offers no rename override, so without this the bracemark-expo app
would have to reference `fontFamily: 'Inter Variable'` on iOS while Android used
a different name. Rewriting the name records to a plain "Inter" lets both
platforms resolve `fontFamily: 'Inter'` (and the Uniwind `font-sans` utility)
after a build-time embed — no runtime `useFonts` load needed.

This modifies the committed TTF in place, so it is a documented, reproducible
step rather than a mystery binary. Re-run it whenever you download a new Inter
release into `apps/bracemark-expo/assets/fonts/`.

Requires fonttools (`brew install fonttools`, or `pip install fonttools`).

    python3 tools/scripts/rename-inter.py apps/bracemark-expo/assets/fonts/InterVariable.ttf
"""

import sys

from fontTools.ttLib import TTFont

WINDOWS_UNICODE_EN_US = (3, 1, 0x409)  # platformID, encodingID, langID
MAC_ROMAN_ENGLISH = (1, 0, 0)


def rename(path: str, family: str = "Inter") -> None:
    font = TTFont(path)
    name = font["name"]

    # Derive the style from the font itself so one script handles regular/italic.
    is_italic = bool(font["head"].macStyle & 0x02)
    subfamily = "Italic" if is_italic else "Regular"
    full = f"{family} {subfamily}" if is_italic else family
    postscript = f"{family}-{subfamily}"

    records = {
        1: family,      # Font Family name
        2: subfamily,   # Font Subfamily name
        4: full,        # Full font name
        6: postscript,  # PostScript name
        16: family,     # Typographic Family name
        17: subfamily,  # Typographic Subfamily name
    }
    for name_id, value in records.items():
        for platform in (WINDOWS_UNICODE_EN_US, MAC_ROMAN_ENGLISH):
            name.setName(value, name_id, *platform)

    font.save(path)
    print(f"Renamed {path}: family='{family}', subfamily='{subfamily}', "
          f"postscript='{postscript}'")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: rename-inter.py <path-to.ttf> [family-name]")
    rename(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "Inter")
