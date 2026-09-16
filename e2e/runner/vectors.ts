import { type NativeRun } from './native-run';
import { type E2ECase } from './registry';

// THE third contract run: the frozen vectors on device.
//
// The sibling of web-to-mobile.ts and mobile-to-web.ts, and the one that needs
// no dev stack at all — no api, no account, no browser. Those two prove the two
// implementations agree with each other through a real round trip; this proves
// the native one still agrees with the FROZEN TABLE, which is the half a round
// trip structurally cannot see: params that drift on both platforms in the same
// release round-trip perfectly and lock every existing user out of their data.
//
// `@stxapps/expo-crypto`'s own contract-vectors.spec.ts asserts the same table
// under jest, where react-native-quick-crypto is shimmed onto Node — so it
// covers our mapping and framing, not the C++ that ships. This is that suite
// with the shim taken away.
//
// Prerequisites: a bracemark-expo dev build on a booted simulator/emulator, with
// Metro up. No `npm run dev` needed — see e2e/README.md.
export async function runVectors(run: NativeRun, testCase: E2ECase): Promise<void> {
  await run.runCase(testCase);
  console.log('contract vectors on device: OK');
}
