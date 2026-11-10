import { entitlementsOf, PLANS } from './plans';

// How a library's storage is SAID, on every surface that says it: the marketing
// site's pricing page prints a plan's ceiling, and Settings → Subscription on
// both apps prints what the library uses against it. One formatter, so the
// "5 GB" a buyer read is the "5 GB" the readout counts towards.
//
// Binary units under decimal names: a GB here is 1024³ bytes, the way the
// ceilings are defined (`maxBytes: 5 * GIB`, plans.ts) and the way most people's
// computers report a file. Printing the ceiling in true decimal GB would turn
// 5 GiB into "5.37 GB", a number nobody chose.

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

// One decimal below ten of a unit, whole numbers from ten up: "1.2 GB",
// "12 GB", "830 MB". A trailing ".0" is dropped.
//
// ROUNDED DOWN, like the ceiling beside it, never to nearest. The readout prints
// usage against the ceiling, and to nearest, 4.96 GB of a 5 GB ceiling read
// "5 GB of 5 GB used" over a bar that wasn't full and a note that said so; a
// unit's last stretch printed as "1024 MB". Rounded down, the text reaches the
// ceiling only when the bytes do, and the last value of a unit is 1023.
// Integer math (bytes × 10 first): a byte count is exact, and the units are
// powers of two, so the tenth it floors to is exact too.
function scaled(bytes: number, unit: number, name: string): string {
  const shown = bytes < 10 * unit ? Math.floor((bytes * 10) / unit) / 10 : Math.floor(bytes / unit);
  return `${Number.isInteger(shown) ? shown : shown.toFixed(1)} ${name}`;
}

/** What a library uses, for a person: "0 KB", "48 KB", "3.4 MB", "1.2 GB". */
export function formatStorageBytes(bytes: number): string {
  if (bytes < MB) return `${Math.floor(bytes / KB)} KB`;
  if (bytes < GB) return scaled(bytes, MB, 'MB');
  return scaled(bytes, GB, 'GB');
}

/**
 * A plan's ceiling as it is promised: "5 GB". Rounded DOWN to a whole unit, so
 * the printed number is never more than the server allows — 5 GiB prints as
 * "5 GB", and a ceiling of 5.5 GiB would too.
 */
export function formatStorageCeiling(maxBytes: number): string {
  if (maxBytes >= GB) return `${Math.floor(maxBytes / GB)} GB`;
  return `${Math.floor(maxBytes / MB)} MB`;
}

// The ceilings that are PUBLISHED: a plan's byte ceiling is printed only where a
// paying user can honestly reach it, and today that is the plans that keep
// copies (`keptCopies`). Screenshots are what fill a library; without them the
// link cap binds long before bytes do, and printing a ceiling nobody can reach
// would only invite a comparison with storage products on an axis Bracemark
// doesn't compete on. So Free's ceiling stays unpublished — on the pricing page
// and in the app alike, since a readout is the same promise read from the
// other side.
const PUBLISHED_CEILINGS: ReadonlySet<number> = new Set(
  PLANS.filter((plan) => entitlementsOf(plan).keptCopies).map(
    (plan) => entitlementsOf(plan).maxBytes,
  ),
);

/**
 * Whether a ceiling — as `GET /v1/files/usage` reports it, which is the
 * account's HIGH-WATER plan's — is one the product publishes, and so one the
 * app may show usage against. A lapsed Plus account still answers yes: its
 * ceiling is still Plus's, and so is the library it filled.
 */
export function isPublishedStorageCeiling(maxBytes: number): boolean {
  return PUBLISHED_CEILINGS.has(maxBytes);
}
