// The item's icon/image presentation chain — the expo port of bracemark-web's
// `_layouts/shared/link-media.tsx` (canonical doc for the chain's design: the
// deterministic Monogram, the Favicon that falls back to it, why the fallbacks
// are steady states, the fixed-size contract with the layouts). Shared by both
// link-item renderers (link-row, link-card). Divergences here:
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
//  - Monogram is a View tile, not SVG: its consumers are the small fixed icon
//    slots, so the letter size is fixed too (10/16 of the size-4 tile, web's
//    viewBox ratio) instead of scaling with the box.
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

// A deterministic monogram for a host — web's Monogram: an icon-less site still
// gets a consistent mark to recognize rows by (and the tile never changes under
// the user when the real icon later lands).
function Monogram({ host, className }: { host: string; className: string }) {
  return (
    <View
      aria-hidden
      className={`items-center justify-center ${className}`}
      style={{ backgroundColor: `hsl(${hueFromHost(host)}, 45%, 45%)` }}
    >
      <Text className="text-[10px] font-semibold text-white">{initialFromHost(host)}</Text>
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
// favicon-provider). Falls back to the monogram whenever there are no bytes to
// show — in flight, no reachable favicon, or (by design, not failure) for
// every host while the extraction opt-in is off. So the fallback is a steady
// state, not just a loading state.
export function Favicon({ host, className }: { host: string; className: string }) {
  const uri = useFaviconUri(host);
  const [isBroken, markBroken] = useBrokenUri();
  if (!uri || isBroken(uri)) return <Monogram host={host} className={className} />;
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

// The image-less card fallback: a full-bleed panel painted with the host's hue
// (same hsl family as the Monogram tile) — web's PreviewFallbackPanel: the real
// favicon, when present, sits centered on a white chip (its own light
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
// Until a uri exists — or when the link has no image at all — the slot shows a
// fallback keyed by `fallback`: the small site favicon on a muted background
// (`icon`, the row's compact slot) or the full-bleed hue panel (`panel`, the
// card's banner). Either way the placeholder still identifies the link and the
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

  if (uri) {
    // recyclingKey is the whole reason this slot is expo-image: FlashList
    // RECYCLES this view down the list, and on a plain Image the previous link's
    // photo stays painted until this file decodes — a wrong-thumbnail flash on
    // any fast scroll. Changing the key blanks the view first. (The fallbacks
    // below are steady states, not that gap — they render when there is no uri
    // at all.)
    //
    // cachePolicy 'memory': a file id is IMMUTABLE (content written once under a
    // minted id — file-store.ts), so unlike the favicon above nothing can go
    // stale under this uri, and the cache pays for re-decoding a 1024px JPEG as
    // rows recycle back into view. 'disk' would duplicate the file it just read.
    return (
      <Image
        source={{ uri }}
        accessibilityIgnoresInvertColors
        contentFit="cover"
        cachePolicy="memory"
        recyclingKey={uri}
        className={className}
      />
    );
  }

  const host = hostFromText(link.url);
  if (fallback === 'panel') {
    return <PreviewFallbackPanel host={host} className={className} />;
  }
  return (
    <View className={`items-center justify-center bg-muted ${className}`}>
      <Favicon host={host} className={iconClassName ?? ''} />
    </View>
  );
}
