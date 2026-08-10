import { SafeAreaView } from 'react-native-safe-area-context';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { withUniwind } from 'uniwind';

import { SettingsScrollHost } from '../../../features/settings/scroll-host';
import { SectionContent } from '../../../features/settings/section-content';
import { DEFAULT_SECTION_ID, isSettingsSectionId } from '../../../features/settings/sections';
import { Topbar } from '../../../features/settings/topbar';

// Composites (not core hosts) need Uniwind's HOC to accept `className` — the
// auth-screen's pattern.
const StyledSafeAreaView = withUniwind(SafeAreaView);

// One settings section, addressed by its id in the path (`/settings/lists`, …)
// — the expo port of bracemark-web's `(app)/settings/[section]/page.tsx`. The id
// is user-supplied (a deep link can carry anything), so validate it against
// the known sections — anything else lands on the default section (the
// Redirect stands in for web's notFound()). The shared frame is split per the
// platform: the section menu is the Drawer (this group's _layout), the topbar
// renders here above the scrolling content. Thin by convention — the UI is in
// src/features/settings/.
export default function SettingsSectionScreen() {
  const { section } = useLocalSearchParams<{ section: string }>();
  if (!section || !isSettingsSectionId(section)) {
    return <Redirect href={`/settings/${DEFAULT_SECTION_ID}`} />;
  }

  return (
    <StyledSafeAreaView className="flex-1 bg-background">
      <Topbar section={section} />
      {/* The scrolling frame lives in the feature (scroll-host.tsx): the Lists
          and Tags tables drag rows INSIDE it, so the scroll view is part of that
          machinery (scroll offset, auto-scroll, locking) rather than page
          furniture. It still does the keyboard-aware job it always did. */}
      <SettingsScrollHost>
        <SectionContent section={section} />
      </SettingsScrollHost>
    </StyledSafeAreaView>
  );
}
