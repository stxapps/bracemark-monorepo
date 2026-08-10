import { redirect } from 'next/navigation';

import { DEFAULT_SECTION_ID } from './sections';

// `/settings` has no section of its own — it's just the entry URL. Redirect to
// the default section so we always land on a concrete `/settings/[section]`
// route. `DEFAULT_SECTION_ID` stays the single source of truth for which one.
export default function SettingsPage() {
  redirect(`/settings/${DEFAULT_SECTION_ID}`);
}
