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

export const metadata: Metadata = {
  // This app serves from the `app.` subdomain — the apex is bracemark-site, a
  // separate app on a separate origin (docs/hosting.md) — so card images, which
  // must be absolute, resolve against THIS origin. They live in this app's
  // `public/`, not on the apex.
  metadataBase: new URL('https://app.bracemark.com'),
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
    url: 'https://app.bracemark.com',
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
