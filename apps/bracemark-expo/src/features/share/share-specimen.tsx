// The one object the share sheet is about — the page — drawn the way the
// library draws it, and the only thing on this surface whose SHAPE changes when
// the save lands. It is the RN port of bracemark-extension's
// `popup/PageSpecimen.tsx` (that header is canonical), down to the
// measurements: a 64x40 preview slot, a 15px title, `gap-3.5`, and a 12px
// corner cut. That slot is the LIBRARY ROW's — `features/links/link-row.tsx`
// passes `h-10 w-16` to LinkPreviewImage, and so does bracemark-web's — which is
// what the specimen is for. It was a 44px square on both platforms until the
// four surfaces that draw this object were measured against each other; the
// argument, and what the 12px cut now reads against, is in the web header.
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
// THE CORNER IS THE SAVE — on the OBJECT — and it is the meaning the fold ALREADY
// carries on the extension's tile (docs/brand-assets.md, _the mark_: square is
// unsaved, cut is saved), the same meaning on the same job, not a third one. It is
// NOT the whole signal, whatever this comment used to say: `share-screen.tsx`'s
// saved phase prints "Saved to <list>" and swaps the controls beneath, exactly as
// the popup's does. The cut is the only part of the confirmation that happens to
// the THING rather than to the chrome around it, which is why the specimen does
// not move across the save; the words carry the state.
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

const SLOT_W = 64; // w-16 — the library row's preview slot, verbatim
const SLOT_H = 40; // h-10 —  ""
const CUT = 12; // 0.75rem — the extension specimen's cut, verbatim

// The overlay that takes the corner off: a square rotated 45° and centred on the
// slot's top-right corner. Its half-diagonal is the cut, so its lower-left edge
// runs exactly from (SLOT_W − CUT, 0) to (SLOT_W, CUT) — the chamfer — and its
// body covers everything beyond, the rounded corner's arc included (the arc sits
// 3.3px from the corner, the chamfer 8.5px, so nothing of it survives). It
// erases the plate's border along the diagonal too, which is not a defect: web's
// `clip-path` erases its ring there for the same reason, so the two match.
// Painted in `--background` because that is what the specimen always sits on; it
// spills past the slot by half its width onto the same colour, so no clipping is
// needed and none is applied — `overflow-hidden` plus a transform is the one
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
      {/* The hue field FILLS the slot, as web's monogram branch does — this sheet
          has no favicon and no image to fall back FROM (see the divergences
          above), so the mark is the only identity there will ever be here and it
          gets the whole rectangle. `text-2xl` (24px) tracks web's letter, which is
          `fontSize="10"` on a 16-unit-tall viewBox and so renders at 25 in a
          40px-tall slot.

          `mt-0.5` for the reason the row's slot carries it: `items-start` aligns
          this box to the title's text box, whose glyphs start ~1.5px below that
          edge, so a flush tile reads as sitting high. */}
      <View
        aria-hidden
        className="mt-0.5 shrink-0 items-center justify-center rounded border border-foreground/10"
        style={{
          width: SLOT_W,
          height: SLOT_H,
          backgroundColor: `hsl(${hueFromHost(host)}, 45%, 45%)`,
        }}
      >
        <Text className="text-2xl font-semibold text-white">{initialFromHost(host)}</Text>
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
