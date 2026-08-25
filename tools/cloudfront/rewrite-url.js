/**
 * rewrite-url — the CloudFront **viewer request** function for both static sites.
 *
 * bracemark-web (`app.<domain>`) and bracemark-site (the apex) are `output: 'export'`
 * Next apps served from a private S3 bucket through CloudFront (docs/hosting.md).
 * A bucket reached through an Origin Access Control is an OBJECT store, not a
 * website endpoint: no index document, no directory semantics, no clean URLs.
 * `next build` writes the page for /support to the key `support.html`, so without
 * this function the only URL that works is /support.html. This function IS the
 * clean-URL layer, and it is also where www folds onto the apex.
 *
 * Rules 1-3 canonicalize and collapse into ONE 301, so https://www.bracemark.com/support/
 * costs a single hop; rules 4-6 rewrite to the origin key, invisibly to the viewer.
 *
 * One function per tier — `rewrite-url-staging`, `rewrite-url-production` — each
 * shared by that tier's two distributions, and both are this file. How to publish
 * one, what the distribution must otherwise be configured with, and how to test a
 * change on staging first: docs/hosting.md, _clean URLs — the CloudFront function_.
 *
 * Runtime: cloudfront-js-2.0. Two constraints that bite from outside the code —
 * the file, COMMENTS INCLUDED, must stay under CloudFront's unadjustable 10 KB
 * function-size limit, and it runs synchronously on every viewer request, cache
 * hits included, against a compute-utilization budget. Keep it linear and short.
 */

// A 301 with nothing to say about caching is cached by browsers indefinitely,
// which makes a mistake in the rules above unrecoverable for anyone who hit it
// once. An hour costs nothing: this function runs on every viewer request anyway,
// so a shorter-lived redirect saves no origin traffic and no CloudFront work.
const REDIRECT_MAX_AGE = 'max-age=3600';

/**
 * Rebuild the query string exactly as it arrived. A redirect that drops it breaks
 * real URLs — /links/?list=inbox&q=... is bracemark-web's whole addressing scheme
 * (docs/search.md).
 *
 * Values are re-emitted VERBATIM, deliberately: CloudFront hands the function the
 * parameters as the viewer sent them, and AWS's own normalize-query-string-parameters
 * sample round-trips them the same way. Running encodeURIComponent over them again
 * would turn a legitimate %20 into %2520.
 *
 * @param {Object} querystring - `event.request.querystring`
 * @returns {string} '' or '?a=1&b=2'
 */
function queryString(querystring) {
  const parts = [];
  for (const name in querystring) {
    const param = querystring[name];
    // Duplicate parameters (?tag=a&tag=b) arrive collapsed into ONE field carrying a
    // multiValue array, and `value` repeats the first of them — read both and the
    // first value ships twice.
    if (param.multiValue) {
      param.multiValue.forEach((entry) => parts.push(name + '=' + entry.value));
    } else {
      // A valueless parameter (?compact) comes back as ?compact= , which every
      // parser we have — URLSearchParams included — reads identically.
      parts.push(name + '=' + param.value);
    }
  }
  return parts.length > 0 ? '?' + parts.join('&') : '';
}

/**
 * @param {string} host - the host to land on, without a scheme
 * @param {string} path - an absolute path, already canonical
 * @param {Object} querystring - `event.request.querystring`
 * @returns {AWSCloudFrontFunction.Response}
 */
function permanentRedirect(host, path, querystring) {
  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: {
      // ABSOLUTE, and that is not a style choice. A location built from the request
      // path alone is an open redirect: a request for `//evil.com/` would send
      // `Location: //evil.com`, which browsers read as scheme-relative and follow
      // off-site. Prefixing the host keeps every redirect on this distribution.
      location: { value: 'https://' + host + path + queryString(querystring) },
      'cache-control': { value: REDIRECT_MAX_AGE },
    },
  };
}

/**
 * @param {AWSCloudFrontFunction.Event} event
 * @returns {AWSCloudFrontFunction.Request | AWSCloudFrontFunction.Response}
 */
function handler(event) {
  const request = event.request;
  const uri = request.uri;

  // Hosts are case-insensitive and CloudFront passes the header through as sent, so
  // match in lowercase. `host` is always present in practice — HTTP/1.1 requires it
  // and CloudFront routes on it — but the guard means a malformed request falls
  // through to a 404 instead of throwing, which CloudFront would serve as a 500.
  const host = request.headers.host ? request.headers.host.value.toLowerCase() : '';

  // --- canonicalize: at most one redirect, whatever is wrong with the URL ---

  // 1. www.bracemark.com -> bracemark.com. Only fires where a `www.` alias is on
  //    the distribution at all, which is the apex's; `app.` has none. The second
  //    test rejects a bare `www.` Host header rather than redirecting to `https:///`.
  let canonicalHost = host;
  if (host.startsWith('www.') && host.slice(4).includes('.')) canonicalHost = host.slice(4);

  let path = uri;

  // 2. Trailing slashes. `/` is the one path allowed to end in one. Repeated
  //    slashes collapse in the same hop, so `/support///` costs one redirect.
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  // 3. The `.html` the S3 keys actually carry. Both spellings resolve to a real
  //    object, so both are live URLs for one page and one of them has to be
  //    canonical; neither app emits a <link rel="canonical"> to settle it.
  //
  //    `/index.html` is EXEMPT and must stay that way. If a distribution ever gets
  //    a default root object configured — a common hardening recommendation, and
  //    something compliance scanners flag as MISSING — CloudFront may resolve `/`
  //    to `/index.html` before this function runs, and redirecting that back to `/`
  //    would be an infinite loop. Rule 4 below serves the root without that setting,
  //    so leave it empty (docs/hosting.md).
  if (path.endsWith('.html') && path !== '/index.html') path = path.slice(0, -5) || '/';

  if (canonicalHost !== host || path !== uri) {
    return permanentRedirect(canonicalHost, path, request.querystring);
  }

  // --- rewrite to the key the export wrote ---------------------------------

  // 4. The root. Done here rather than with a default root object so the two
  //    mechanisms can't disagree, and so this file is the only thing that decides
  //    what a URL means.
  if (path === '/') {
    request.uri = '/index.html';
    return request;
  }

  // 5. A dot in the last segment means a real file, not a page: /favicon.ico,
  //    /sw.js, /manifest.json, everything under /_next/, and the .txt RSC payloads
  //    Next writes beside every page (/links.txt,
  //    /settings/__next.!KGFwcCk.settings.txt). The client router fetches those on
  //    in-app navigations, so appending .html here would break navigation itself,
  //    not just one asset.
  if (path.slice(path.lastIndexOf('/') + 1).includes('.')) return request;

  // 6. A page. /settings/misc -> the key `settings/misc.html`. A path matching no
  //    key (/nope -> /nope.html) 404s at S3 and the distribution's custom error
  //    response turns that into /404.html with a 404 status — a fetch that never
  //    comes back through this function.
  request.uri = path + '.html';
  return request;
}
