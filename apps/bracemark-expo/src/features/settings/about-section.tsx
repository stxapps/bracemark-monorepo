// The About settings section — the RN port of bracemark-web's
// `(app)/settings/[section]/_about/about-section.tsx`, block for block: the brand
// card, Pages, Legal, the colophon. Read that file's header for why the section
// exists and why the rows carry descriptions; this one records only what native
// does differently.
//
// TWO DIFFERENCES, both deliberate:
//
//   - IT SHOWS A VERSION, which web's doesn't. This app is an installed artifact:
//     a user can be running a build from three releases ago, the answer to "which
//     one?" is not visible anywhere else on the device, and it is the first thing
//     a support reply and an App Review note both ask for. Web is a static export
//     where every visitor has whatever the last deploy pushed.
//   - THE ROWS OPEN THE SYSTEM BROWSER (`Linking.openURL`), which backgrounds this
//     app rather than opening a tab beside it. That is why they carry the
//     out-arrow instead of the chevron (settings-kit's `external`) — the glyph is
//     the only warning a user gets that pressing it leaves.
//
// The mark renders at 40px, the one departure from the 20px lockup shared by
// every other surface (docs/brand-assets.md — _the mark_): everywhere else the brand is
// a carrier that has to agree with the six other surfaces, and here it is the
// subject of the screen.

import { Linking, View } from 'react-native';
import Constants from 'expo-constants';
import {
  CircleQuestionMark,
  Globe,
  Info,
  LifeBuoy,
  type LucideIcon,
  Scale,
  ShieldCheck,
} from 'lucide-react-native';

import { BRAND, COMPANY } from '@stxapps/shared';

import { BracemarkIcon } from '../../components/icons/bracemark-icon';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { ABOUT_URL, FAQ_URL, PRIVACY_URL, SITE_URL, SUPPORT_URL, TERMS_URL } from '../../lib/site';
import { SettingsGroup, SettingsHeader, SettingsPane, SettingsRow } from './settings-kit';

interface PageLink {
  url: string;
  icon: LucideIcon;
  title: string;
  description: string;
}

const PAGES: PageLink[] = [
  {
    url: SITE_URL,
    icon: Globe,
    title: 'Home page',
    description: 'Bracemark on the public web.',
  },
  {
    url: ABOUT_URL,
    icon: Info,
    title: 'About Bracemark',
    description: 'Who makes it, and why it works the way it does.',
  },
  {
    url: FAQ_URL,
    icon: CircleQuestionMark,
    title: 'FAQ',
    description: 'Accounts, encryption, plans, and what happens if you forget your password.',
  },
  {
    url: SUPPORT_URL,
    icon: LifeBuoy,
    title: 'Support',
    description: 'Get help, or tell us something is broken.',
  },
];

const LEGAL: PageLink[] = [
  {
    url: TERMS_URL,
    icon: Scale,
    title: 'Terms',
    description: 'The terms you accepted when you created your account.',
  },
  {
    url: PRIVACY_URL,
    icon: ShieldCheck,
    title: 'Privacy',
    description: 'What we collect, and what the encryption keeps us from seeing.',
  },
];

function PageRows({ pages }: { pages: PageLink[] }) {
  return (
    <View className="gap-3">
      {pages.map((page) => (
        <SettingsRow
          key={page.url}
          icon={<Icon as={page.icon} className="size-5 text-muted-foreground" />}
          title={page.title}
          description={page.description}
          onPress={() => void Linking.openURL(page.url)}
          external
        />
      ))}
    </View>
  );
}

// The marketing version plus the build, from the config `expo prebuild` baked in
// — `expo-constants` reads what shipped, so a release build reports the release's
// numbers. The build id is the platform's own field and they are different
// concepts (iOS increments a string per upload, Android an integer), so each side
// reads its own rather than inventing a shared one. Rendered as `0.0.0 (1)`, the
// form both stores and every crash reporter use.
function versionLabel(): string {
  const config = Constants.expoConfig;
  const version = config?.version ?? '—';
  const build = config?.ios?.buildNumber ?? config?.android?.versionCode;

  return build === undefined || build === null ? version : `${version} (${build})`;
}

export function AboutSection() {
  return (
    <SettingsPane>
      <SettingsHeader title="About" description="What this app is, and where to read more." />

      {/* `descriptor`, not `tagline`: the tagline ("the bookmark manager that
          can't read your bookmarks") is written for a hero with supporting copy
          around it to resolve the "…is it broken?" reading, and this line has
          none. The slogan closes the screen instead, where a sign-off belongs. */}
      <View className="items-center gap-3 rounded-lg border border-border px-6 py-8">
        <BracemarkIcon height={40} />
        <View className="items-center gap-1">
          <Text className="text-lg font-semibold tracking-tight">{BRAND.name}</Text>
          <Text className="text-center text-sm text-muted-foreground">{BRAND.descriptor}</Text>
        </View>
        <Text className="text-xs text-muted-foreground">Version {versionLabel()}</Text>
      </View>

      <SettingsGroup title="Pages">
        <PageRows pages={PAGES} />
      </SettingsGroup>

      <SettingsGroup title="Legal">
        <PageRows pages={LEGAL} />
      </SettingsGroup>

      {/* The colophon. Muted, centered, and the only block here with nothing to
          press — it is the end of the screen, not a row you missed. */}
      <View className="items-center gap-1 pt-2">
        <Text className="text-center text-sm text-muted-foreground">{BRAND.slogan}</Text>
        <Text className="text-xs text-muted-foreground">
          © {new Date().getFullYear()} {COMPANY.legalName}
        </Text>
      </View>
    </SettingsPane>
  );
}
