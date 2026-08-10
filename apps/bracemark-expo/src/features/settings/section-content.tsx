// A thin switch that renders the content for one settings section — the expo
// port of bracemark-web's `(app)/settings/[section]/section-content.tsx`. Each
// section is its own component, so they can grow independently. The section
// comes from the route param (see `(app)/settings/[section].tsx`), so this is
// a plain prop-driven component.

import { AboutSection } from './about-section';
import { AccountSection } from './account-section';
import { DataSection } from './data-section';
import { ExtractionSection } from './extraction-section';
import { ListsSection } from './lists-section';
import { MiscSection } from './misc-section';
import { type SettingsSectionId } from './sections';
import { SubscriptionSection } from './subscription-section';
import { TagsSection } from './tags-section';

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
