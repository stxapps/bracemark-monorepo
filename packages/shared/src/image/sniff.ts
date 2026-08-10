// The two BYTE SNIFFS every fetching path uses to decide whether what came back
// is an image at all — `sniffImageMime` for raster, `isSvgBytes` for the one
// format only the icon path takes. Pure byte shapes: no decoder, no platform
// API, no I/O, which is why they sit here rather than beside the decoders that
// consume them.
//
// They started in `@stxapps/expo-react`'s lib/image.ts, next to `resizeImage`/
// `probeImageSize` (thin wrappers over native decoders — those STAY there, on
// the platform whose decoders they wrap). They moved when the web favicon path
// needed the same verdict: web reads the icon's bytes back from the extractor
// proxy and must ask the identical question of them, so leaving the answer on
// one platform would have meant two definitions of "is this an icon" drifting
// apart. See extract/favicon.ts, which is the verdict both fillers actually call.
//
// The LINE BETWEEN THE TWO is the thing to preserve: `sniffImageMime` is the
// STORED-PREVIEW path's verdict and must keep refusing SVG (see its header);
// `isSvgBytes` exists only so the ICON path can accept the one thing the preview
// path can't.

// The RASTER formats a fetching path may keep (every decoder in play — ImageIO,
// Fresco, SDWebImage, Glide on native, the browser's own on web — covers this
// set, ICO included), identified by magic bytes. This is the verdict the
// STORED-PREVIEW path wants exactly, and the reason is downstream: expo's
// `probeImageSize` and `resizeImage` are both raster-only, so anything that
// passes here must be something they can measure and cap — an SVG would sail
// past the 1024px cap and land whole in the user's byte quota. The ICON path
// wants MORE than this; see `isSvgBytes` below. An HTML error page (no magic
// bytes) misses either way, which is the case that actually shows up.
//
// Returns the mime rather than a boolean because two callers need it: the icon
// path stamps it on the Blob it renders through (web's `useFaviconUrl`), and it
// keeps the store-path check self-documenting where it doesn't.
export function sniffImageMime(b: Uint8Array): string | undefined {
  if (b.length < 12) return undefined;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image/x-icon';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return undefined;
}

// How far in to look for the root tag. A favicon is capped at MAX_FAVICON_BYTES,
// but the prologue that may precede `<svg>` is an XML declaration, a comment or
// two and a doctype — a kilobyte is generous for that, and nothing past it can
// change the verdict.
const SVG_SNIFF_BYTES = 1024;

// Only an XML declaration, comments, or an SVG doctype may precede the root tag.
// That's the whole point of anchoring: an HTML error page can carry an inline
// `<svg>` ANYWHERE in it, so "contains `<svg`" would accept exactly the thing
// this check exists to reject, while "the document's FIRST tag is `<svg>`" puts
// `<!DOCTYPE html>`/`<html>` out of reach.
const SVG_ROOT =
  /^\s*(?:(?:<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE\s+svg\b[^>]*>)\s*)*<svg[\s/>]/i;

// Is this an SVG document? The one NON-raster format the icon path accepts, and
// the reason it can: both platforms' icon renderers decode SVG (expo-image via
// SDWebImageSVGCoder on iOS / androidsvg on Android; an `<img>` on web, given
// the right Blob type — see extract/favicon.ts's `sniffIconMime`) — and
// `<link rel=icon type="image/svg+xml">` is common enough that rejecting it left
// those hosts on the monogram permanently. Deliberately NOT folded into
// `sniffImageMime`: that verdict guards the store path, which must keep saying
// no (see its header).
//
// Sniffing text takes more care than magic bytes — hence SVG_ROOT above. Only
// the head is decoded, and TextDecoder is non-fatal, so binary input degrades to
// replacement characters and simply fails to match (a raster format would have
// been caught by the magic-byte sniff first anyway); it also strips a leading
// BOM for us.
export function isSvgBytes(b: Uint8Array): boolean {
  return SVG_ROOT.test(new TextDecoder().decode(b.subarray(0, SVG_SNIFF_BYTES)));
}
