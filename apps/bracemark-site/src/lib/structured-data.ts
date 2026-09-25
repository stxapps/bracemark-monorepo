// The schema.org JSON-LD the marketing site publishes, rendered by
// components/json-ld.tsx: the site-wide graph on the landing page, and an
// FAQPage on /faq.
//
// NOTHING IN HERE IS NEW COPY, and that is the rule for adding to it. Structured
// data is read by machines and proofread by nobody — no one sees it rendered, so
// a sentence that exists only here is a claim that skipped every review the page
// copy gets (docs/brand-assets.md). Every string below is a constant some visible
// surface already prints: the brand lines, the company, the store listings, the
// plan prices, and the FAQ's own answers. A field that would need a sentence of
// its own stays out.
//
// Only what we can state without a caveat, for the same reason. No
// `aggregateRating`: ratings live in four stores and move daily, so one typed
// here is stale on arrival and the one number nobody can check. So no rich
// result for the app —
// Google requires a rating for one — and that is fine: the point is the entity,
// who publishes it and where else it lives, stated once in a form a machine does
// not have to infer from prose.

import { isValidElement, type ReactNode } from 'react';

import {
  APP_STORE_URL,
  AVAILABLE_PAID_PLANS,
  BRAND,
  CHROME_WEB_STORE_URL,
  COMPANY,
  FIREFOX_ADDONS_URL,
  LIFETIME_ON_SALE,
  LIFETIME_PLAN,
  LIFETIME_USD,
  PLAN_LABELS,
  PLAN_USD_PER_YEAR,
  PLAY_STORE_URL,
  SOCIAL,
  SOURCE,
} from '@stxapps/shared';

import type { BlogPost } from '../content/blog';
import type { FaqGroup } from '../content/faq';
import { SITE_URL } from './site';

const ORGANIZATION_ID = `${SITE_URL}/#organization`;

// The prices /pricing prints, from the same constants: the BASE price in USD,
// which is what a country with no local price is actually billed
// (PLAN_USD_PER_YEAR's header in @stxapps/shared). The lifetime offer follows
// LIFETIME_ON_SALE like every other surface, so it appears here when it appears
// on /pricing and not before.
const OFFERS = [
  { '@type': 'Offer', name: PLAN_LABELS.free, price: 0, priceCurrency: 'USD' },
  ...AVAILABLE_PAID_PLANS.map((plan) => ({
    '@type': 'Offer',
    name: PLAN_LABELS[plan],
    price: PLAN_USD_PER_YEAR[plan],
    priceCurrency: 'USD',
    priceSpecification: {
      '@type': 'UnitPriceSpecification',
      price: PLAN_USD_PER_YEAR[plan],
      priceCurrency: 'USD',
      referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'ANN' },
    },
  })),
  ...(LIFETIME_ON_SALE
    ? [
        {
          '@type': 'Offer',
          name: `Lifetime ${PLAN_LABELS[LIFETIME_PLAN]}`,
          price: LIFETIME_USD,
          priceCurrency: 'USD',
        },
      ]
    : []),
];

/**
 * Who we are, what the product is, and every other place it lives — for the
 * landing page, which is where a crawler looks for the site's own identity.
 *
 * Three nodes, linked by `@id`. The Organization is the legal entity from
 * COMPANY, not the brand: it is who /terms and /privacy name, and its website is
 * the company's own. The product is the SoftwareApplication, whose `sameAs` is
 * what ties the store listings, the X account and the repository to this domain
 * as one thing rather than several similarly named ones. The WebSite node is what
 * Google reads a site name from, so results say "Bracemark" and not the host.
 *
 * `description` is the descriptor line verbatim — the brand line written for a
 * surface that supplies no context of its own, which is exactly what a knowledge
 * graph entry is. Not the meta description: that one argues, this one names.
 */
export const SITE_GRAPH = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': ORGANIZATION_ID,
      name: COMPANY.shortName,
      legalName: COMPANY.legalName,
      url: COMPANY.url,
      address: COMPANY.addressLines.join(', '),
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      name: BRAND.name,
      url: `${SITE_URL}/`,
      inLanguage: 'en',
      publisher: { '@id': ORGANIZATION_ID },
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_URL}/#app`,
      name: BRAND.name,
      description: BRAND.descriptor,
      url: `${SITE_URL}/`,
      // The 180px mark `app/apple-icon.png` already publishes at this path.
      image: `${SITE_URL}/apple-icon.png`,
      // From Google's closed list, which has no "productivity"; the category
      // only matters to a rich result, and this is the nearest honest fit.
      applicationCategory: 'UtilitiesApplication',
      // The browser extensions are not a platform of their own — they are in
      // `sameAs` below, and the web app already runs in those browsers.
      operatingSystem: 'Web, iOS, Android',
      publisher: { '@id': ORGANIZATION_ID },
      offers: OFFERS,
      sameAs: [
        APP_STORE_URL,
        PLAY_STORE_URL,
        CHROME_WEB_STORE_URL,
        FIREFOX_ADDONS_URL,
        SOCIAL.url,
        SOURCE.url,
      ],
    },
  ],
};

/**
 * The FAQ as an FAQPage, from the same groups /faq renders — so the markup can
 * never answer a question differently from the page it sits on, which is the
 * condition Google puts on it.
 */
export function faqPage(groups: FaqGroup[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    url: `${SITE_URL}/faq`,
    mainEntity: groups
      .flatMap((group) => group.items)
      .map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: plainText(item.a) },
      })),
  };
}

/** The article's visible title, description and dates, with no new claims. */
export function blogPosting(post: BlogPost) {
  const url = `${SITE_URL}/blog/${post.slug}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    '@id': `${url}#article`,
    headline: post.title,
    description: post.description,
    url,
    mainEntityOfPage: url,
    datePublished: post.publishedAt,
    ...(post.updatedAt && { dateModified: post.updatedAt }),
    author: { '@type': 'Organization', name: BRAND.name, url: `${SITE_URL}/about` },
    publisher: { '@id': ORGANIZATION_ID },
  };
}

/**
 * The text a node renders, without rendering it — an FAQ answer is JSX, and
 * `react-dom/server` is refused in a server component.
 *
 * Walks `children` where an element has them, and calls a plain function
 * component where it has none (MailLink prints its `address` prop, not its
 * children). That is enough for what the FAQ is built from and no more: a
 * component that renders text of its own AND takes children would lose the
 * former here. Nothing at build time would say so, which is why
 * `structured-data.spec.tsx` holds this against the DOM's `textContent` for
 * every answer.
 */
export function plainText(node: ReactNode): string {
  return textOf(node).replace(/\s+/g, ' ').trim();
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!isValidElement<{ children?: ReactNode }>(node)) return '';
  const { type, props } = node;
  if (props.children !== undefined) return textOf(props.children);
  if (typeof type === 'function') return textOf((type as (p: object) => ReactNode)(props));
  return '';
}
