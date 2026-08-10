// The two deterministic, pure derivations that give an icon-less host a stable
// visual identity — the same host always draws the same letter on the same hue:
// bracemark-web's monogram tile and card hue panel, and bracemark-expo's card panel
// alike. Hoisted here from bracemark-web's link-media.tsx when the expo card layout
// became the second consumer (the same move as LinkQuery): if each app hashed
// hosts its own way, the "same site, same color" recognition cue would break the
// moment a user switches devices. Callers feed the DISPLAY host (hostFromText),
// so the derivation matches the host string rendered beside it.

// The single letter an icon-less host is recognized by: its first alphanumeric,
// uppercased ('?' when there is none, e.g. a bare punycode fragment).
export function initialFromHost(host: string): string {
  return (/[a-z0-9]/i.exec(host)?.[0] ?? '?').toUpperCase();
}

// Cheap string hash → hue. Only the HUE varies: callers pair it with fixed
// saturation/lightness (45%/45%) where white text stays legible on every hue and
// in both themes.
export function hueFromHost(host: string): number {
  let hash = 0;
  for (let i = 0; i < host.length; i++) hash = (hash * 31 + host.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}
