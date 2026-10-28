// The About settings section: what this app is, and every page about it that
// lives somewhere else.
//
// WHY IT EXISTS AT ALL. It is the app's only door to the marketing site's About,
// FAQ, Terms and Privacy pages — before this, `TERMS_URL` and `PRIVACY_URL` were
// exported by lib/site.ts and imported by nothing, so a signed-in user could not
// reach the terms they agreed to without typing the apex by hand. Support was the
// single exception (the links topbar's overflow menu), and it is repeated here
// because this section is the INDEX of the off-app pages; a link is not state, so
// two doors to it cost nothing.
//
// THE SHAPE, top to bottom: the mark and what the product is; the pages; the
// legal pages; who publishes it. That order is the questions a person actually
// opens About to answer, in the order they ask them.
//
// It renders the mark at 40px, which is the ONE surface allowed to depart from
// the 20px lockup every other surface shares (docs/brand-assets.md — _the mark_). The
// rule exists for surfaces where the brand is a CARRIER and has to agree with the
// six others a user might have just come from; here the brand is the SUBJECT of
// the page. A 20px lockup under a 20px "About" heading reads as a nav fragment
// that wandered in from the rail.
//
// NO VERSION LINE, unlike bracemark-expo's port of this section, which shows one.
// The difference is honest rather than an omission: a native app is an installed
// artifact whose user can be on a build from months ago (and a store reviewer
// will ask which), while this app is a static export behind a service worker —
// every visitor is on whatever the last deploy pushed. A number here would have
// to be invented (`package.json` says 0.0.0) to answer a question nobody on this
// platform has.
//
// A server component: static links, no hooks, nothing to hydrate. The copyright
// year is therefore the BUILD's year, same as the marketing site's footer.

import {
  Activity,
  AtSign,
  CircleQuestionMark,
  Code,
  Globe,
  Info,
  LifeBuoy,
  Scale,
  ShieldCheck,
} from 'lucide-react';

import { BRAND, COMPANY, SOCIAL, SOURCE, STATUS } from '@stxapps/shared';
import { BracemarkIcon } from '@stxapps/web-ui/components/icons/bracemark-icon';
import { cn } from '@stxapps/web-ui/lib/utils';

import {
  SettingsGroup,
  SettingsHeader,
  SettingsPane,
  SettingsRow,
} from '../../_components/settings-kit';

import { ABOUT_URL, FAQ_URL, PRIVACY_URL, SITE_URL, SUPPORT_URL, TERMS_URL } from '@/lib/site';

// The rows, as data, because the two groups render identically and the only thing
// that differs between them is which pages they hold. Descriptions earn their
// place on an external link in a way they don't on an in-app row: the user cannot
// peek at where a new tab goes, so the row says what is behind it before they
// spend the click.
const PAGES = [
  {
    href: SITE_URL,
    icon: <Globe className="size-5" />,
    title: 'Home page',
    description: 'Bracemark on the public web.',
  },
  {
    href: ABOUT_URL,
    icon: <Info className="size-5" />,
    title: 'About Bracemark',
    description: 'Who makes it, and why it works the way it does.',
  },
  {
    href: FAQ_URL,
    icon: <CircleQuestionMark className="size-5" />,
    title: 'FAQ',
    description: 'Accounts, encryption, plans, and what happens if you forget your password.',
  },
  {
    href: SUPPORT_URL,
    icon: <LifeBuoy className="size-5" />,
    title: 'Support',
    description: 'Get help, or tell us something is broken.',
  },
  {
    // Beside Support because it answers the question a user brings there first —
    // is it me, or is it down? — without writing to anyone. It is the first of
    // the rows that leave the apex: the status page is served by GitHub, apart
    // from everything it reports on (docs/hosting.md, _the status page_), and this
    // section still renders when our API is down, since the app is a static
    // export. Production's in every tier — staging has no status page.
    //
    // Here and NOT in a sync error, which also fires when the user is offline —
    // where a link to a page they cannot load blames the wrong party.
    href: STATUS.url,
    icon: <Activity className="size-5" />,
    title: 'Status',
    description: 'Whether each part of Bracemark is answering right now.',
  },
  {
    // A row that doesn't point at the marketing site, and with Status above it
    // the reason this list isn't just "the pages on the apex". It earns the seat: an
    // app whose pitch is that we CAN'T read your library should say, on the
    // surface where it describes itself, where to go and check that.
    //
    // "read", not "verify" — the claim boundary is the same one /about and the
    // FAQ hold (docs/brand-assets.md — _the source_), and a settings row has no room to
    // qualify itself, so it must not overclaim in the first place.
    href: SOURCE.url,
    icon: <Code className="size-5" />,
    title: 'Source code',
    description: `Read what runs on your device. ${SOURCE.license}.`,
  },
  {
    // The third row that isn't the marketing site, and the only one pointing at
    // a property we don't control — which is why it sits last, after the rows
    // that are ours, mirroring where the site's footer puts it (under _Company_
    // with "Status" and "Source code", never under _Product_).
    //
    // TITLED WITH THE HANDLE, like the footer's link and for the footer's reason
    // (docs/brand-assets.md — _the X account_): "X" alone names nothing read cold, and
    // `@bracemarkapp` is not derivable from the product name — `@bracemark` was
    // taken — so a user who means to search for us rather than press this has to
    // be able to read the string we actually hold. From `SOCIAL`, never retyped:
    // a wrong handle here credits someone else's account and looks exactly like
    // a right one.
    //
    // The description says announcements and stops there. Support is three rows
    // above this one, and it is email on purpose — a public reply is the
    // wrong shape for questions that carry usernames (docs/brand-assets.md — _not on
    // /support_), so this row must not read as a second way to reach us.
    href: SOCIAL.url,
    icon: <AtSign className="size-5" />,
    title: SOCIAL.handle,
    description: 'Announcements and release notes, on X.',
  },
];

const LEGAL = [
  {
    href: TERMS_URL,
    icon: <Scale className="size-5" />,
    title: 'Terms',
    description: 'The terms you accepted when you created your account.',
  },
  {
    href: PRIVACY_URL,
    icon: <ShieldCheck className="size-5" />,
    title: 'Privacy',
    description: 'What we collect, and what the encryption keeps us from seeing.',
  },
];

export function AboutSection() {
  return (
    <SettingsPane>
      <SettingsHeader title="About" description="What this app is, and where to read more." />

      {/* The brand block. `descriptor`, not `tagline`: the tagline ("the bookmark
          manager that can't read your bookmarks") is written for a hero that has
          supporting copy around it to resolve the "…is it broken?" reading, and
          this line has none — it sits alone under the name. The slogan closes the
          section instead, where a sign-off belongs. Both come from BRAND rather
          than being typed, which is the whole reason that file exists
          (docs/brand-assets.md — _the brand lines_). */}
      <div
        className={cn(
          'flex flex-col items-center gap-3 rounded-lg border border-border px-6 py-8 text-center',
        )}
      >
        <BracemarkIcon className={cn('h-10 w-auto')} aria-hidden="true" />
        <div className={cn('flex flex-col gap-1')}>
          <p className={cn('text-lg font-semibold tracking-tight')}>{BRAND.name}</p>
          <p className={cn('text-sm text-muted-foreground')}>{BRAND.descriptor}</p>
        </div>
      </div>

      {/* Both groups are captioned by their heading alone — a description under
          "Pages" would explain a list of seven labelled links, which is the kind of
          text a settings surface accretes and nobody reads. */}
      <SettingsGroup title="Pages">
        <div className={cn('flex flex-col gap-3')}>
          {PAGES.map((page) => (
            <SettingsRow key={page.href} {...page} />
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Legal">
        <div className={cn('flex flex-col gap-3')}>
          {LEGAL.map((page) => (
            <SettingsRow key={page.href} {...page} />
          ))}
        </div>
      </SettingsGroup>

      {/* The colophon. Muted, centered, and the only place on this surface with no
          control — it is the end of the page, not a row you missed. */}
      <div className={cn('flex flex-col items-center gap-1 pt-2 text-center')}>
        <p className={cn('text-sm text-muted-foreground')}>{BRAND.slogan}</p>
        <p className={cn('text-xs text-muted-foreground')}>
          © {new Date().getFullYear()} {COMPANY.legalName}
        </p>
      </div>
    </SettingsPane>
  );
}
