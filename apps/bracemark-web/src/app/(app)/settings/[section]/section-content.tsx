// A thin switch that renders the content for one settings section. Each section
// is its own component, so they can grow real forms independently. The section
// comes from the route param (see page.tsx alongside this file), so this is a
// plain prop-driven component: no hooks, no 'use client'. A section adds its own
// 'use client' when it grows interactivity — About and this file don't have any.

import { type SettingsSectionId } from '../sections';
import { AboutSection } from './_about/about-section';
import { AccountSection } from './_account/account-section';
import { DataSection } from './_data/data-section';
import { ExtractionSection } from './_extraction/extraction-section';
import { ListsSection } from './_lists/lists-section';
import { MiscSection } from './_misc/misc-section';
import { SubscriptionSection } from './_subscription/subscription-section';
import { TagsSection } from './_tags/tags-section';

const SECTIONS: Record<SettingsSectionId, () => React.ReactNode> = {
  account: () => <AccountSection />,
  subscription: () => <SubscriptionSection />,
  data: () => <DataSection />,
  extraction: () => <ExtractionSection />,
  lists: () => <ListsSection />,
  tags: () => <TagsSection />,
  misc: () => <MiscSection />,
  about: () => <AboutSection />,
};

export function SectionContent({ section }: { section: SettingsSectionId }) {
  const Section = SECTIONS[section];
  return <Section />;
}
