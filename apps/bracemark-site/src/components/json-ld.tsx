// A schema.org block, for the crawlers and answer engines that read structured
// data rather than prose. What goes in each one is lib/structured-data.ts.
//
// The CSP does not apply: `application/ld+json` is a data block, which the
// browser never executes, so it needs no hash and no `'unsafe-inline'`
// (docs/hosting.md, _security headers_).
//
// `<` is escaped because the payload is interpolated into HTML, not parsed as
// it. JSON.stringify leaves `</script>` intact, and any string in here — an FAQ
// answer today — that ever contains it would close the tag early and spill the
// rest into the page. A JSON parser reads the `\u003c` escape back as `<`.
export function JsonLd({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}
