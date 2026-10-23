import { BRAND } from '@stxapps/shared';

import { PRICING_URL, PRIVACY_URL, SITE_URL, SUPPORT_URL, TERMS_URL } from '@/lib/site';

// The only content in this app's HTML that is not drawn by JavaScript. Every page
// here is a static-export shell whose <body> is empty until the client renders it
// (`/` routes and renders nothing — HomeRedirect), so a fetch that doesn't run
// scripts reads a blank page with a title and concludes the site isn't live.
// Paddle's checkout-domain review is one such reader, and app.bracemark.com has
// to pass it: checkout opens here, and the default payment link points here
// (docs/iap.md, _the payment link_).
//
// <noscript>, not visible markup: a browser with JavaScript never paints it, so
// nobody sees a flash of this before the app draws. Text rendered into the shell
// instead would show on every cold load, signed in or not.
//
// Rendered from the root layout rather than from `/`, because the layout's body
// is the one place the static HTML is guaranteed to carry — and every page here
// needs JavaScript, not just `/`.
export function NoScriptNotice() {
  const siteHost = new URL(SITE_URL).host;

  return (
    <noscript>
      <main className="mx-auto max-w-md p-6 text-sm leading-6">
        <h1 className="text-lg font-semibold">{BRAND.name}</h1>
        <p className="text-muted-foreground">{BRAND.descriptor}.</p>
        <p className="mt-4">
          This is the {BRAND.name} web app. It runs in your browser and needs JavaScript. Turn on
          JavaScript to sign in.
        </p>
        <ul className="mt-4 list-none space-y-1 p-0 underline underline-offset-2">
          <li>
            <a href={SITE_URL}>{siteHost}</a>
          </li>
          <li>
            <a href={PRICING_URL}>Pricing</a>
          </li>
          <li>
            <a href={TERMS_URL}>Terms of Service</a>
          </li>
          <li>
            <a href={PRIVACY_URL}>Privacy Policy</a>
          </li>
          <li>
            <a href={SUPPORT_URL}>Support</a>
          </li>
        </ul>
      </main>
    </noscript>
  );
}
