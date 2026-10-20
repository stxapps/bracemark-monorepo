// The item's icon/image presentation chain — the expo port of bracemark-web's
// `_layouts/shared/link-media.tsx` (canonical doc for the chain's design: the
// deterministic HostMonogram, the Favicon that falls back to a quiet plate so the
// row escalates once rather than twice, why the fallbacks are steady states, the
// fixed-size contract with the layouts). Shared by both link-item renderers
// (link-row, link-card). Divergences here:
//
//  - Favicons come from expo-react's device-local per-host cache
//    (useFaviconUri — a DIRECT native fetch under the extraction opt-in, no
//    extractor proxy; see favicon-provider.tsx), as the cached icon file's
//    `file://` uri rather than an object URL. Native decoders don't cover
//    every byte stream a host may serve (the provider's sniff pre-filters),
//    so the render keeps an onError backstop: a favicon that fails to DECODE
//    falls back to the monogram instead of a blank tile.
//  - Images are local plaintext uris (useImageFileUri — content lives decrypted
//    on disk, file-store.ts), rendered by EXPO-IMAGE rather than core RN Image.
//    Two reasons, both spelled out at the call sites below: `recyclingKey`,
//    without which a FlashList-recycled view keeps painting the previous link's
//    picture until this one decodes; and SVG decoding, which is what lets the
//    icon sniff accept `<link rel=icon type="image/svg+xml">` at all (expo-react
//    lib/image.ts — `isSvgBytes`). Note the sources are ALREADY on local disk,
//    so no `cachePolicy` here may be 'disk'/'memory-disk': that would duplicate
//    the library into a second copy on the same device.
//  - HostMonogram is a View tile, not SVG, so its letter cannot scale with the
//    box the way web's viewBox does — the size is a class. There is one size
//    left, `text-xl`: web's `FONT_SIZE` of 8 worked out against the 40px-tall
//    row slot (8/16 x 40). Nothing enforces that it tracks web — see the note at
//    `fontSize` in web-ui's host-monogram.tsx. The host chip's `text-[10px]`
//    tile went when `Favicon` below stopped drawing one.
//  - RN's color parser wants the comma hsl() syntax (web's space-separated
//    form isn't universally parsed), hence the style props.

import { useState } from 'react';
import { View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { withUniwind } from 'uniwind';

import { type LinkView, useFaviconUri, useImageFileUri } from '@stxapps/expo-react';
import { hostFromText, hueFromHost, initialFromHost } from '@stxapps/shared';

import { Text } from '../../components/ui/text';

// expo-image's `Image` is a composite, not a core RN host, so Uniwind needs the
// wrapper to reach its `style` — the SafeAreaView treatment. Every slot here is
// sized by `className`, so this is load-bearing, not cosmetic.
const Image = withUniwind(ExpoImage);

// The quiet plate both fallbacks below paint — web's `PLATE_CLASS`, verbatim, and
// web's link-media.tsx has why the alpha is per theme. An alpha toward the
// foreground (the tag chips' mechanism, at a different tone) rather than
// `bg-muted`: a selected item is `bg-muted` itself, so a muted plate was gone for
// as long as the user was picking links.
const PLATE_CLASS = 'bg-foreground/4 dark:bg-foreground/8';

// A deterministic monogram for a host — the expo counterpart of web-ui's
// HostMonogram: an icon-less site still gets a consistent mark to recognize rows
// by (and the tile never changes under the user when the real icon later lands).
function HostMonogram({ host, className }: { host: string; className: string }) {
  return (
    <View
      aria-hidden
      className={`items-center justify-center ${className}`}
      style={{ backgroundColor: `hsl(${hueFromHost(host)}, 45%, 45%)` }}
    >
      {/* `text-xl` in the box's own units, not a fraction of it — see the header.
          One caller, one size: 8/16 of the 40px row slot this only ever fills, so
          it is a constant here as `FONT_SIZE` is on web. It was a per-caller prop
          while the host chip drew a `text-[10px]` tile; that went with `Favicon`'s
          monogram. */}
      <Text className="text-xl font-semibold text-white">{initialFromHost(host)}</Text>
    </View>
  );
}

// The decode-failure memory behind the onError backstop (see the header): the
// uri that failed, so the component falls back to the monogram for it. Keyed by
// uri rather than a bare boolean because FlashList RECYCLES these instances
// instead of remounting them — the same component renders a different host (and
// so a different cached-file uri) as rows scroll by, and one undecodable icon
// must not poison the fallback for every host that follows. It is NOT a
// loading-state guard: useFaviconUri only yields a uri once the bytes are on
// disk, so onError means a real decode failure, never "not fetched yet". The
// per-host file path is stable, so bytes REPLACED under a still-mounted host
// (device-extraction's declared-icon capture landing over a guessed
// /favicon.ico) keep the stale verdict until the instance is recycled — self-
// healing and cosmetic; key on the row's fetchedAt if that ever matters.
function useBrokenUri(): [(uri: string) => boolean, (uri: string) => void] {
  const [brokenUri, setBrokenUri] = useState<string>();
  return [(uri) => uri === brokenUri, setBrokenUri];
}

// The site's favicon, keyed by DISPLAY HOST — web's Favicon: cached per host
// and fetched at most once per host per device (useFaviconUri /
// favicon-provider). Falls back to a QUIET PLATE whenever there are no bytes to
// show — in flight, no reachable favicon, a decode failure (the onError backstop
// above), or (by design, not failure) for every host while the extraction opt-in
// is off, which is the default. So the fallback is a steady state, not just a
// loading state, and on a device that never opted in it is the only state.
//
// Not the monogram, which is what it drew until this line beside the host TEXT
// turned out to be the row's second escalation: the tile's letter is
// `initialFromHost` of the string rendered right next to it, and with no image
// the slot below was already filling 64x40 with that same letter on that same
// hue. A plate rather than nothing keeps the host strings on one left edge. Web's
// `Favicon` carries the full argument.
export function Favicon({ host, className }: { host: string; className: string }) {
  const uri = useFaviconUri(host);
  const [isBroken, markBroken] = useBrokenUri();
  if (!uri || isBroken(uri)) return <View aria-hidden className={`${PLATE_CLASS} ${className}`} />;
  // contain, not cover: a favicon is a whole mark, so it letterboxes rather
  // than crops (unlike the preview image, which is a photo filled into a box).
  //
  // cachePolicy 'none' — the file IS the cache. A second copy buys nothing here
  // (1–2 KB, already local) and costs correctness: the per-host path is STABLE
  // while its bytes are REPLACEABLE (device-extraction's declared-icon capture
  // landing over the guessed /favicon.ico — see useBrokenUri's note above), so
  // anything keyed on the uri would go on serving the superseded icon. Re-reading
  // it per mount is the cheaper side of that trade.
  return (
    <Image
      source={{ uri }}
      accessibilityIgnoresInvertColors
      contentFit="contain"
      cachePolicy="none"
      recyclingKey={uri}
      className={className}
      onError={() => markBroken(uri)}
    />
  );
}

// The image-less ROW fallback — web's PreviewFallbackIcon, and its reasoning
// verbatim: the favicon on a quiet plate, escalating to the monogram FILLING the
// slot when there is no favicon either, because that is the state where the mark
// is the only identity left. It is the row's ONE escalation — the host chip above
// yields to it. It resolves the favicon itself rather than delegating to
// `Favicon` (which renders a bare plate in this state) for the reason web gives —
// the SLOT is what has to know whether there are bytes.
//
// The plate is `PLATE_CLASS` rather than `bg-muted`, and this is the slot where
// that cost most: on a selected row (`bg-muted`, link-row.tsx) a muted plate is
// the row's own fill, which left a 16pt favicon marooned in an invisible 64x40.
//
// The row's slot is `overflow-hidden rounded` already (link-row.tsx), so the
// field's square corners are clipped by the caller, as web's `rx={0}` is.
function PreviewFallbackIcon({
  host,
  className,
  iconClassName,
}: {
  host: string;
  className: string;
  iconClassName?: string;
}) {
  const uri = useFaviconUri(host);
  const [isBroken, markBroken] = useBrokenUri();
  if (!uri || isBroken(uri)) return <HostMonogram host={host} className={className} />;
  return (
    <View className={`items-center justify-center ${PLATE_CLASS} ${className}`}>
      {/* Same slot as Favicon, same reasoning — see its cachePolicy note. */}
      <Image
        source={{ uri }}
        accessibilityIgnoresInvertColors
        contentFit="contain"
        cachePolicy="none"
        recyclingKey={uri}
        className={iconClassName ?? ''}
        onError={() => markBroken(uri)}
      />
    </View>
  );
}

// The image-less card fallback: a full-bleed panel painted with the host's hue
// (same hsl family as the HostMonogram tile) — web's PreviewFallbackPanel: the
// real favicon, when present, sits centered on a white chip (its own light
// background, so it never clashes with the panel hue); with no favicon — the
// default while the extraction opt-in is off — the panel carries a large
// centered letter instead.
function PreviewFallbackPanel({ host, className }: { host: string; className: string }) {
  const uri = useFaviconUri(host);
  const [isBroken, markBroken] = useBrokenUri();
  return (
    <View
      className={`items-center justify-center ${className}`}
      style={{ backgroundColor: `hsl(${hueFromHost(host)}, 45%, 45%)` }}
    >
      {uri && !isBroken(uri) ? (
        <View className="rounded-md bg-white/95 p-1.5 shadow-sm">
          {/* Same slot as Favicon, same reasoning — see its cachePolicy note. */}
          <Image
            source={{ uri }}
            accessibilityIgnoresInvertColors
            contentFit="contain"
            cachePolicy="none"
            recyclingKey={uri}
            className="size-9"
            onError={() => markBroken(uri)}
          />
        </View>
      ) : (
        <Text aria-hidden className="text-4xl font-semibold text-white/95">
          {initialFromHost(host)}
        </Text>
      )}
    </View>
  );
}

// The link's preview-image slot — web's LinkPreviewImage, verbatim in contract:
// `imageId` is the row's override-wins image ref (LinkView), read local-first
// and fetched on demand the moment the item mounts (FlashList items are
// virtualized, so mounted = displayed — useImageFileUri adds the settle delay).
// When the link has no image at all — or its file isn't on this device yet — the
// slot shows a fallback keyed by `fallback`: the site favicon on a quiet plate, escalating
// to the full-bleed monogram when there is no favicon either (`icon`, the row's
// compact slot), or the full-bleed hue panel (`panel`, the card's banner). Either way the placeholder still identifies the link and the
// geometry never shifts — both call sites pass a FIXED-size `className` (the
// card's height budget depends on it).
export function LinkPreviewImage({
  link,
  className,
  iconClassName,
  fallback = 'icon',
}: {
  link: LinkView;
  className: string;
  iconClassName?: string;
  fallback?: 'icon' | 'panel';
}) {
  const uri = useImageFileUri(link.imageId);

  // `null` is the fallback's case (no image, or nothing local yet); `undefined`
  // is the read still in flight, and it keeps THIS view mounted with no source.
  if (uri !== null) {
    // FlashList RECYCLES this view down the list, so the previous link's photo
    // must be gone in the render that hands it the next link — a wrong-thumbnail
    // flash on any fast scroll otherwise. The null source is what does that: the
    // hook reports in flight for the beat after `imageId` changes, and expo-image
    // clears a view whose source went away. Not the fallback for that beat — it
    // is a monogram, so it would flash between two photos on every recycle, and
    // swapping to it tears this native view down and builds it again.
    //
    // recyclingKey was this slot's only guard and it was a beat late: it is fed
    // from the uri, which arrived WITH the new source, and until then the hook
    // went on returning the previous link's. It stays as expo-image's own guard
    // for a source swapped with no in-flight render between. (The fallbacks
    // below are steady states, not that gap.)
    //
    // cachePolicy 'memory': a file id is IMMUTABLE (content written once under a
    // minted id — file-store.ts), so unlike the favicon above nothing can go
    // stale under this uri, and the cache pays for re-decoding a 1024px JPEG as
    // rows recycle back into view. 'disk' would duplicate the file it just read.
    return (
      <Image
        source={uri ? { uri } : null}
        accessibilityIgnoresInvertColors
        contentFit="cover"
        cachePolicy="memory"
        recyclingKey={uri}
        // The plate behind a real image too, as on web: a logo on a
        // transparent background otherwise loses its edge, and a dark one
        // disappears into a dark row. Opaque images cover it.
        className={`${PLATE_CLASS} ${className}`}
      />
    );
  }

  const host = hostFromText(link.url);
  if (fallback === 'panel') {
    return <PreviewFallbackPanel host={host} className={className} />;
  }
  return <PreviewFallbackIcon host={host} className={className} iconClassName={iconClassName} />;
}
