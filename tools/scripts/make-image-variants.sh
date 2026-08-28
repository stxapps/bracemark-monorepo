#!/usr/bin/env bash
#
# Generate the responsive width variants for a static image in a `public/`
# folder — a marketing screenshot, an illustration, anything the build serves
# as a file rather than as user data.
#
#   tools/scripts/make-image-variants.sh <source> <output-stem> [width ...]
#
#   tools/scripts/make-image-variants.sh ~/Desktop/capture.png \
#     apps/bracemark-site/public/screenshots/library-cards
#
# writes `library-cards-1100.webp`, `-1600.webp` and `-2200.webp` next to each
# other and prints the `widths:` line to paste into the page. Run it once per
# asset, by hand, and commit what it produces.
#
# WHY THIS IS A RUN-ONCE SCRIPT AND NOT A BUILD STEP
#
# Both Next apps are `output: 'export'` with `images.unoptimized` (docs/hosting.md
# — the whole site prerenders to `out/` and is served from S3 + CloudFront), so
# `next/image` has no optimizer behind it and emits the same `<img>` the page
# would have written itself. The usual answer to that is
# `next-image-export-optimizer`, which was considered and declined: it pulls
# `sharp` and `typescript` in as runtime dependencies, moves `images` onto a
# custom loader, replaces every `<img>` with its own component, and writes
# generated files into `public/` during the build — which is a build target whose
# outputs overlap its inputs, and a working tree that is dirty after a build.
#
# That machinery pays for itself when the image count is unbounded: a blog with a
# cover per post, or assets dropped in by people who do not run the build.
# bracemark-site has a handful of fixed screenshots, and bracemark-web has none
# at all worth optimizing — every image IT renders is user data behind an object
# URL built from IndexedDB or R2 bytes (`_layouts/shared/link-media.tsx`,
# `use-image-file-url.ts`, `use-favicon-url.ts`), which no build-time optimizer
# and no `next/image` loader can see. Three files and one `srcSet` attribute is
# less machinery than the config diff. Revisit when that stops being true.
#
# WHY THESE WIDTHS
#
# The default ladder is sized to the marketing site's content column: `Band` puts
# its children in `max-w-6xl` (72rem = 1152px) inside `lg:px-8`, so a full-bleed
# figure is **1088 CSS px** at the desktop cap. Hence 1100 (1x), 2200 (2x) and
# 1600 in between, which is what a phone at DPR 3 and a tablet land on. Pass your
# own widths as trailing arguments when the box is a different size — and name
# the width in the file, as this script does, so a file and its `w` descriptor
# cannot drift apart.
#
# The page pairs these with `sizes`, NOT with `@1x`/`@2x` density descriptors.
# Density descriptors are chosen on device pixel ratio alone and ignore layout
# width, so a DPR-3 phone downloads the 2200px file to paint a ~360px box: the
# largest transfer lands on the connection least able to absorb it.
#
# WEBP, AND `-strip`
#
# WebP is the right codec for text-heavy UI captures and is supported by every
# browser these apps target. AVIF would compress a little further and is
# deliberately not attempted — it needs a second `<picture>` source and a second
# set of files, which is not worth it for one image. `-strip` drops metadata: a
# screenshot straight off a device carries EXIF, and this repo should not be the
# reason a capture's provenance ships to the apex.

set -euo pipefail

DEFAULT_WIDTHS=(1100 1600 2200)
QUALITY=82

usage() {
  cat >&2 <<'EOF'
usage: tools/scripts/make-image-variants.sh <source> <output-stem> [width ...]

  <source>       the capture to downscale. Must be at least as wide as the
                 largest width requested — this script never upscales.
  <output-stem>  path with no width suffix and no extension, e.g.
                 apps/bracemark-site/public/screenshots/library-cards
  [width ...]    widths in px. Defaults to 1100 1600 2200.
EOF
}

src=${1:-}
stem=${2:-}
if [ -z "$src" ] || [ -z "$stem" ]; then
  usage
  exit 2
fi
shift 2

widths=("$@")
if [ ${#widths[@]} -eq 0 ]; then
  widths=("${DEFAULT_WIDTHS[@]}")
fi

if [ ! -f "$src" ]; then
  echo "error: no such file: $src" >&2
  exit 1
fi

if ! command -v magick >/dev/null 2>&1; then
  cat >&2 <<'EOF'
error: ImageMagick 7 (`magick`) not found.

  brew install imagemagick

No-install alternative, one command per width:

  npx sharp-cli -i <source> -o <dir> resize <width> -- format webp
EOF
  exit 1
fi

# `[0]` pins the first frame: an animated or multi-page source would otherwise
# resize every frame and write a directory's worth of files. The here-string is
# what makes this safe under `set -e`: `identify -format` writes no trailing
# newline, and a `read` that hits EOF without one returns non-zero and takes the
# whole script down with no message.
read -r src_w src_h <<<"$(magick identify -format '%w %h' "${src}[0]")"
echo "source: $src (${src_w}×${src_h})"

# Never upscale. A variant wider than its source is bytes spent on interpolation
# and a `w` descriptor that lies about the detail behind it.
max_w=0
too_big=()
for w in "${widths[@]}"; do
  if [ "$w" -gt "$max_w" ]; then
    max_w=$w
  fi
  if [ "$w" -gt "$src_w" ]; then
    too_big+=("$w")
  fi
done
if [ ${#too_big[@]} -gt 0 ]; then
  echo "error: source is ${src_w}px wide; cannot produce ${too_big[*]}." >&2
  echo "       Recapture at >= ${max_w}px, or pass smaller widths." >&2
  exit 1
fi

mkdir -p "$(dirname "$stem")"

for w in "${widths[@]}"; do
  out="${stem}-${w}.webp"
  magick "${src}[0]" -resize "${w}x" -strip -quality "$QUALITY" -define webp:method=6 "$out"
  printf '  %-60s %s\n' "$out" "$(du -h "$out" | cut -f1 | tr -d ' ')"
done

echo
echo "paste into the page's screenshot entry:"
printf '  widths: ['
printf '%s' "${widths[0]}"
printf ', %s' "${widths[@]:1}"
printf '],\n'
