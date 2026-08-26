import type { Metadata } from 'next';
import { Inter } from 'next/font/google';

import { themeInitScript } from '@stxapps/shared';

import { InnerLayout } from './inner-layout';

import './globals.css';

const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' });

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: 'rgb(17, 24, 39)' },
  ],
};

// This app's own origin, for the card metadata below. It has to be absolute:
// og:image and twitter:image resolve against `metadataBase`, and the card images
// live in THIS app's `public/` — the apex is bracemark-site, a separate app on a
// separate origin (docs/hosting.md), so a relative URL would resolve to the wrong
// host.
//
// Env-configured for the same reason NEXT_PUBLIC_SITE_URL is (lib/site.ts), and
// under the same var name bracemark-site uses for this same origin: it is
// per-tier (`app.bracemark.com`, `app.dryrunbase.com`, or :3000 in dev) and baked
// at build time, so a hard-coded value makes every staging build advertise
// production's URLs in its OG tags. Throws rather than defaulting — a default is
// what let the hard-coded one pass unnoticed.
const appUrl = process.env.NEXT_PUBLIC_APP_URL;
if (!appUrl) throw new Error('NEXT_PUBLIC_APP_URL is not set');

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: 'Bracemark - Save links to visit later',
  description:
    'Save links to everything and visit them later easily, anytime, on any device, with technology that empowers you to truly own your account and data.',
  openGraph: {
    title: 'Bracemark - Save links to visit later',
    description:
      'Save links to everything and visit them later easily, anytime, on any device, with technology that empowers you to truly own your account and data.',
    images: [
      {
        url: '/twitter-card-image-pattern5.png',
      },
    ],
    siteName: 'Bracemark',
    url: appUrl,
    type: 'website',
  },
  twitter: {
    title: 'Bracemark - Save links to visit later',
    description:
      'Save links to everything and visit them later easily, anytime, on any device, with technology that empowers you to truly own your account and data.',
    images: ['/twitter-card-image-pattern5.png'],
    card: 'summary_large_image',
    // `site:` deliberately omitted: it held @bracedotto, the legacy Brace.to handle.
    // Set it once a Bracemark handle actually exists — a wrong handle credits
    // someone else's account on every share.
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body>
        {/* Set the `.dark` class before paint so there's no flash of the wrong
            theme. Runs synchronously ahead of hydration. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript() }} />
        <InnerLayout>{children}</InnerLayout>
      </body>
    </html>
  );
}
