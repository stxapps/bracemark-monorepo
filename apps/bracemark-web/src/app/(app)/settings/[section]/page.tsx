import { notFound } from 'next/navigation';

import { isSettingsSectionId, SETTINGS_SECTION_IDS } from '../sections';
import { SectionContent } from './section-content';

// `output: export` builds every dynamic route ahead of time, so enumerate the
// known section ids here — one static page per `/settings/<id>`. Any other path
// isn't generated and falls through to the page's own `notFound()` guard.
export function generateStaticParams() {
  return SETTINGS_SECTION_IDS.map((section) => ({ section }));
}

// One settings section, addressed by its id in the path (`/settings/lists`, …).
// The id is user-supplied, so validate it against the known sections — anything
// else 404s. The shared frame (sidebar, topbar) lives in the layout; this page
// just renders the matching content.
export default async function SettingsSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!isSettingsSectionId(section)) notFound();

  return <SectionContent section={section} />;
}
