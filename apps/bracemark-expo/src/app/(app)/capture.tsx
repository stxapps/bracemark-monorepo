import { Redirect, useLocalSearchParams } from 'expo-router';

import { CaptureScreen } from '../../features/capture/capture-screen';

// The capture route — `/capture?link=<id>`: the saved page in a WebView, with "Keep
// read mode" under it. A pushed Stack screen inside (app), behind the auth, lock and
// initial-sync gates. docs/link-extraction-keep.md, _expo_.
export default function CaptureRoute() {
  const { link } = useLocalSearchParams<{ link?: string }>();
  if (!link) return <Redirect href="/links" />;
  return <CaptureScreen linkId={link} />;
}
