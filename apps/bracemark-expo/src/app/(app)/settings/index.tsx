import { Redirect } from 'expo-router';

import { DEFAULT_SECTION_ID } from '../../../features/settings/sections';

// `/settings` has no section of its own — it's just the entry URL. Redirect to
// the default section so we always land on a concrete `/settings/[section]`
// route, mirroring bracemark-web's `(app)/settings/page.tsx` (`redirect(…)`).
// `DEFAULT_SECTION_ID` stays the single source of truth for which one.
export default function SettingsScreen() {
  return <Redirect href={`/settings/${DEFAULT_SECTION_ID}`} />;
}
