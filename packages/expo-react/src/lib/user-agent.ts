// The one string this device presents when it fetches a URL a user saved — the
// page, its preview image, and BOTH favicon paths.
//
// Honest and attributable, not a browser impersonation: a site that wants to
// refuse this traffic should be able to, and a site that wants to ask about it
// has somewhere to look. The cost is the occasional bot-wall, which
// device-extraction's `403` ladder handles. bracemark-extractor states the same
// thing with its own string (`bracemark-extractor/1.0 (+…/extractor)`) —
// deliberately a DIFFERENT one, so a site that walls off the server isn't also
// walling off every phone, and vice versa.
//
// Its own module because both fetching modules need it (lib/device-extraction.ts
// and lib/favicon-fetch.ts) and neither should depend on the other: they sit on
// opposite sides of the gestured/un-gestured line those two headers are about.
export const USER_AGENT = 'Bracemark/1 (+https://bracemark.com)';
