// The one object the share sheet is about — the page — drawn the way the
// library draws it, and the only thing on this surface whose SHAPE changes when
// the save lands. It is the RN port of bracemark-extension's
// `popup/PageSpecimen.tsx` (that header is canonical), down to the
// measurements: a 44px identity tile, a 15px title, `gap-3.5`, and a 12px
// corner cut.
//
// WHY THE EXTENSION'S COMPONENT AND NOT A NEW ONE. The share sheet and the
// browser-extension popup are the same product moment on two platforms — "this
// page, saved or not" — and the popup already learned the lesson this screen
// hadn't. Saving used to read as submitting a form and being handed a receipt:
// a compose screen, then a separate "✓ Saved to Bracemark" screen, two screens
// with nothing visibly in common. Now the page is on screen the whole time and
// the save happens TO it — the controls beneath it change, the specimen stays
// put, and its corner comes off.
//
// THE CORNER IS THE SAVE, and it is the meaning the fold ALREADY carries on the
// extension's tile (docs/brand-assets.md, _the mark_: square is unsaved, cut is
// saved) — the same meaning on the same job, not a third one. No check badge,
// no colour, no state word competing with the title.
//
// TWO DIVERGENCES FROM THE WEB SPECIMEN, both forced by where this runs:
//
//   - THE TILE IS ALWAYS THE MONOGRAM. Web's chain is extracted image → the
//     live tab's favicon → HostMonogram. The sheet has neither of the first two
//     and must not go looking: it never fetches the page, and the iOS extension
//     must stay clear of bytes-heavy work and of the app's sqlite, where a
//     cached favicon would live (docs/share-sheet.md). So the deterministic
//     tile is the whole chain — and it is the SAME tile the library will draw
//     for this host (features/links/link-media.tsx's Monogram, over shared's
//     hueFromHost/initialFromHost), so "same site, same mark" still holds
//     between the sheet and the list it saves into.
//   - THE CUT IS AN OVERLAY, NOT A CLIP. RN has no `clip-path`. The hairline
//     objection that rules this trick out for the auth card
//     (components/dog-eared-card.tsx, which draws a stroked SVG outline
//     instead) does not apply at tile scale: web's own tile loses its ring
//     along the diagonal too, because `clip-path` erases the ring with
//     everything else. A rotated square in the page colour therefore reproduces
//     the web result exactly rather than approximating it — and it costs no SVG
//     in a bundle whose init cost is paid on every cold share.

import { View } from 'react-native';

import { displayUrl, hostFromText, hueFromHost, initialFromHost } from '@stxapps/shared';

import { Text } from '../../components/ui/text';

const TILE = 44; // size-11 — the extension specimen's tile
const CUT = 12; // 0.75rem — the extension specimen's cut, verbatim

// The overlay that takes the corner off: a square rotated 45° and centred on the
// tile's top-right corner. Its half-diagonal is the cut, so its lower-left edge
// runs exactly from (TILE − CUT, 0) to (TILE, CUT) — the chamfer — and its body
// covers everything beyond, the rounded corner's arc included (the arc sits
// 3.3px from the corner, the chamfer 8.5px, so nothing of it survives). Painted
// in `--background` because that is what the specimen always sits on; it spills
// past the tile by half its width onto the same colour, so no clipping is needed
// and none is applied — `overflow-hidden` plus a transform is the one
// combination that renders differently across the two platforms.
const OVERLAY = CUT * Math.SQRT2;

export function ShareSpecimen({
  url,
  title,
  saved = false,
}: {
  url: string;
  // From the share payload only — Android's EXTRA_SUBJECT, iOS's preprocessing
  // JS. Often absent, which is what the fallback chain below is for.
  title?: string;
  // The save has landed: cut the corner.
  saved?: boolean;
}) {
  const host = hostFromText(url);
  // `displayUrl` (shared) keeps the path, so two saves from the same site stay
  // distinguishable, and keeps a bare `http://` visible so the insecure scheme
  // is never hidden from someone deciding whether to keep the page.
  const address = displayUrl(url);

  return (
    <View className="flex-row items-start gap-3.5">
      <View
        aria-hidden
        className="shrink-0 items-center justify-center rounded-lg border border-foreground/10"
        style={{
          width: TILE,
          height: TILE,
          backgroundColor: `hsl(${hueFromHost(host)}, 45%, 45%)`,
        }}
      >
        <Text className="text-lg font-semibold text-white">{initialFromHost(host)}</Text>
        {saved && (
          <View
            className="absolute bg-background"
            style={{
              width: OVERLAY,
              height: OVERLAY,
              top: -OVERLAY / 2,
              right: -OVERLAY / 2,
              transform: [{ rotate: '45deg' }],
            }}
          />
        )}
      </View>

      <View className="min-w-0 flex-1 gap-0.5">
        {/* The extension's fallback chain: the shared title, else the bare host,
            else the address. Two lines, because a real page title routinely
            needs them and a truncated one is the only handle the user has on
            what they are keeping. */}
        <Text
          testID="share-title"
          numberOfLines={2}
          className="text-[0.9375rem] leading-snug font-medium"
        >
          {title || host || address}
        </Text>
        <Text testID="share-url" numberOfLines={1} className="text-xs text-muted-foreground">
          {address}
        </Text>
      </View>
    </View>
  );
}
