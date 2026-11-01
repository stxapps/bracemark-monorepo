import { Redirect, useLocalSearchParams } from 'expo-router';

import { ReaderScreen } from '../../features/reader/reader-screen';

// The reader route — `/read?link=<id>`, the same address bracemark-web uses, so a
// link to one app's reader reads the same in the other. A pushed Stack screen inside
// (app), so it sits behind the auth, lock and initial-sync gates like everything
// else. docs/reader.md.
export default function ReadScreen() {
  const { link } = useLocalSearchParams<{ link?: string }>();
  if (!link) return <Redirect href="/links" />;
  return <ReaderScreen linkId={link} />;
}
