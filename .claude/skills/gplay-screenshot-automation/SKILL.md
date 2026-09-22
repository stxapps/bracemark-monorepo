---
name: gplay-screenshot-automation
description: Manage, validate, and upload Google Play listing screenshots and graphics with the gplay CLI. Use when organizing screenshots by locale and device type and pushing them to a Play listing via gplay images upload, sync import-images, or a release. Vendored from tamtom/gplay-cli-skills and adapted; off by default; `docs/` wins on conflict.
license: MIT
---

# Google Play Screenshot Management

> **Vendored from [tamtom/gplay-cli-skills](https://github.com/tamtom/gplay-cli-skills)
> (MIT, `skills/gplay-screenshot-automation`, upstream `10301b2`), 2026-09-22.**
> Local edits: this block, the frontmatter and prettier's formatting only. Where
> this file and `docs/` disagree, **`docs/` wins** — it is the design record. Off
> by default: `docs/expo-build.md`, _android release — the `gplay` skills_.

## In this repo — read before anything below

- **The app is `apps/bracemark-expo`, package `com.bracemark.app`** — read that wherever
  a command below says `com.example.app`.
- **The service-account JSON is a credential and stays outside the worktree** —
  `~/.gplay/`, the CLI's own default — and auth goes in the global profile
  (`gplay auth login --service-account ~/.gplay/<file>.json`). Never run `gplay init` or
  `gplay auth init --local` inside the checkout: both write `./.gplay/`, which this repo
  does not ignore.
- **Never `gplay snitch --confirm`** — it files a public GitHub issue. `--local` or
  nothing.
- **The listing words have one home**: `PLAY` and `FULL_DESCRIPTION` (and
  `SCREENSHOT_CAPTIONS`) in `packages/shared/src/stores/listing-copy.ts`. Change them
  there and run the `brand-review` skill; any `--dir` metadata tree below is generated
  from that file into a scratch directory **outside the worktree**, never committed as a
  second copy.

Use this skill to organize, validate, and upload Android screenshots and store graphics to a Google Play listing with `gplay`. This skill covers the gplay-specific upload/validate flow — not screenshot _capture_.

Capturing the raw images is standard Android tooling and not gplay-specific: take them with `adb shell screencap` (then `adb pull`), or drive state-based captures with an Espresso / UI Automator instrumentation test, switching emulator locale via `setprop persist.sys.locale` when you need per-language shots. Produce PNGs organized by locale and device type, then use the commands below.

## Directory layout

gplay expects a Fastlane-style tree. `sync import-images` and `release --screenshots-dir` both read this shape:

```
metadata/
  en-US/
    images/
      phoneScreenshots/
        1_home.png
        2_search.png
      tenInchScreenshots/
        1_home.png
      featureGraphic.png
  de-DE/
    images/
      phoneScreenshots/
        1_home.png
```

Screenshots upload in filename order, so prefix with `1_`, `2_`, etc. to control ordering on the store.

## Image types

| Type                   | Usage                             |
| ---------------------- | --------------------------------- |
| `phoneScreenshots`     | Phone screenshots (required, 2-8) |
| `sevenInchScreenshots` | 7-inch tablet screenshots         |
| `tenInchScreenshots`   | 10-inch tablet screenshots        |
| `tvScreenshots`        | Android TV screenshots            |
| `wearScreenshots`      | Wear OS screenshots               |
| `featureGraphic`       | Feature graphic (1024x500)        |
| `promoGraphic`         | Promo graphic (180x120)           |
| `icon`                 | App icon (512x512)                |
| `tvBanner`             | TV banner (1280x720)              |

Google Play requires PNG or JPEG (PNG recommended), max 8 MB per image.

## 1) Validate before uploading

Always validate the directory first — this catches count/dimension/format issues before you spend an upload:

```bash
# Validate all locales
gplay validate screenshots --dir ./metadata --output table

# Validate a single locale
gplay validate screenshots --dir ./metadata --locale en-US --output table
```

## 2) Upload

### Option A — bulk import (preferred)

Imports every image in the Fastlane tree in one command. Requires an open edit:

```bash
EDIT_ID=$(gplay edits create --package com.example.app | jq -r '.id')

gplay sync import-images \
  --package com.example.app \
  --edit "$EDIT_ID" \
  --dir ./metadata          # add --locale en-US to import one locale, --dry-run to preview

gplay edits validate --package com.example.app --edit "$EDIT_ID"
gplay edits commit   --package com.example.app --edit "$EDIT_ID"
```

### Option B — individual images

Use when you need fine control over specific files:

```bash
EDIT_ID=$(gplay edits create --package com.example.app | jq -r '.id')

gplay images upload \
  --package com.example.app \
  --edit "$EDIT_ID" \
  --locale en-US \
  --type phoneScreenshots \
  --file ./metadata/en-US/images/phoneScreenshots/1_home.png

gplay images upload \
  --package com.example.app \
  --edit "$EDIT_ID" \
  --locale en-US \
  --type featureGraphic \
  --file ./metadata/en-US/images/featureGraphic.png

gplay edits validate --package com.example.app --edit "$EDIT_ID"
gplay edits commit   --package com.example.app --edit "$EDIT_ID"
```

### Option C — as part of a release

Upload screenshots alongside a bundle in one release flow:

```bash
gplay release \
  --package com.example.app \
  --track production \
  --bundle app-release.aab \
  --screenshots-dir ./metadata \
  --release-notes @release-notes.json
```

## 3) Replace existing screenshots

`delete-all` clears a type for a locale before re-uploading. It defaults `--confirm` to `false` and will refuse without it, so `--confirm` is REQUIRED:

```bash
EDIT_ID=$(gplay edits create --package com.example.app | jq -r '.id')

gplay images delete-all \
  --package com.example.app \
  --edit "$EDIT_ID" \
  --locale en-US \
  --type phoneScreenshots \
  --confirm

gplay images upload \
  --package com.example.app \
  --edit "$EDIT_ID" \
  --locale en-US \
  --type phoneScreenshots \
  --file ./metadata/en-US/images/phoneScreenshots/1_home.png

gplay edits validate --package com.example.app --edit "$EDIT_ID"
gplay edits commit   --package com.example.app --edit "$EDIT_ID"
```

## 4) Verify what's live

```bash
gplay images list \
  --package com.example.app \
  --edit "$EDIT_ID" \
  --locale en-US \
  --type phoneScreenshots \
  --output table
```

## Agent behavior

- Confirm exact flags with `--help` before running commands.
- Always run `gplay validate screenshots` before uploading.
- Prefer `gplay sync import-images` over many individual `gplay images upload` calls.
- Every write goes through an edit: create → upload/import → validate → commit.
- `images delete-all` needs `--confirm`; without it the command refuses.
- Use explicit long flags (`--package`, `--edit`, `--locale`, `--type`, `--file`).
- Default to JSON for machine steps, `--output table` for human review.
