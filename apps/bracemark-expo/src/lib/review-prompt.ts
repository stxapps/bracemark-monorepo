// The app-store review prompt — WHEN to ask. The OS owns whether anything shows:
// iOS caps it at three a year per install and shows nothing from TestFlight, and
// Play keeps an undisclosed quota and shows nothing for an install that didn't
// come from Play. Neither says whether a sheet appeared, nor whether the user
// has already rated. So this file cannot show a prompt; it can only ask at a
// good moment, and not waste the OS's budget on a bad one.
//
// A good moment is right after something worked, and the one we use is a link
// saved from the add panel — but only the SAVES_BEFORE_ASKINGth since the last
// ask, so a first-day user who has saved two links is never asked to rate a
// habit they haven't formed. Saves from the share sheet count toward that number
// (share-store counts them as they land) but never ask themselves: on Android the
// sheet is a translucent activity closing over someone else's app, and the iOS
// share extension can't raise the sheet at all (it is in that target's
// `excludedPackages` — app.config.ts). Their ask comes on the next save in the app.
//
// NOT after an import. An import is usually the first session — someone moving
// their bookmarks in from somewhere else — so it would ask them to rate the move
// rather than the product, before they have used it. Imported links don't count
// as saves either, for the same reason.
//
// Never after an error, a paywall, a cancelled flow or a restore from Trash —
// the caller only reaches here on the success branch. At most once per
// DAYS_BETWEEN_ASKS, whatever the moment: asking more often than iOS will show
// just spends the ask on a no-op, and on Android — where the quota is not
// published — spacing asks out is the only lever we have.
//
// And not forever. Since neither store says whether the user rated, two things
// stand in for that answer: MAX_ASKS asks in the device's lifetime, and never
// again once the user opened the store's review page themselves from Settings →
// About (`openStoreReviewPage`) — the one signal we CAN see.
//
// `__DEV__` builds never ask. The iOS simulator shows the sheet on EVERY call in
// a development build, which would land in the middle of the Maestro flows that
// save more than a handful of links. To see it, run a release build
// (docs/expo-dependencies.md, _expo-store-review_).

import { Linking, Platform } from 'react-native';
import * as StoreReview from 'expo-store-review';

import {
  readReviewPromptState,
  type ReviewPromptValue,
  writeReviewPromptState,
} from '@stxapps/expo-react';
import { APP_STORE_URL, PLAY_STORE_URL } from '@stxapps/shared';

export const SAVES_BEFORE_ASKING = 10;
export const DAYS_BETWEEN_ASKS = 120;
export const MAX_ASKS = 3;

// Long enough for the add panel to finish closing and the new row to land
// before a system sheet covers it.
export const ASK_DELAY_MS = 1_500;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The bookkeeping after one successful save in the app, and whether to ask now.
 * Pure, so the rules above are testable without a device.
 *
 * `lastAskedAt` is reset when we ASK, not when a sheet shows — nothing reports
 * that. A `lastAskedAt` in the future means the clock moved backwards since;
 * that counts as rested rather than blocking asks until the clock catches up.
 */
export function nextReviewPromptState(
  state: ReviewPromptValue,
  now: number,
): { state: ReviewPromptValue; ask: boolean } {
  const savesSinceAsk = state.savesSinceAsk + 1;
  const done = state.openedStorePage || state.askCount >= MAX_ASKS;
  const rested =
    state.lastAskedAt === null ||
    now < state.lastAskedAt ||
    now - state.lastAskedAt >= DAYS_BETWEEN_ASKS * DAY_MS;
  const earned = savesSinceAsk >= SAVES_BEFORE_ASKING;

  if (!done && rested && earned) {
    return {
      state: { ...state, savesSinceAsk: 0, lastAskedAt: now, askCount: state.askCount + 1 },
      ask: true,
    };
  }
  return { state: { ...state, savesSinceAsk }, ask: false };
}

/**
 * Record a link saved from the add panel and, if it is time, ask for a review a
 * beat later. Fire-and-forget: it never throws and never delays the caller's
 * success path.
 *
 * `requestReview` directly, NOT gated on `isAvailableAsync`. On Android that
 * check looks the Play Store up by package name, which Android 11+ hides from
 * an app whose manifest declares no matching `<queries>` — and the module ships
 * none — so it can answer false where the review flow works. The call itself is
 * safe everywhere we run: Play's flow resolves without UI for a non-Play
 * install, and iOS ignores it on TestFlight. It rejects when there is no
 * foreground scene (backgrounded during the delay), which is swallowed.
 */
export function noteReviewMoment(): void {
  if (__DEV__) return;

  const { state, ask } = nextReviewPromptState(readReviewPromptState(), Date.now());
  writeReviewPromptState(state);
  if (!ask) return;

  setTimeout(() => {
    StoreReview.requestReview().catch(() => {
      // No sheet this time; the ask is spent either way (see above).
    });
  }, ASK_DELAY_MS);
}

/**
 * Where the user writes a review by hand — this platform's listing, from
 * `@stxapps/shared`'s `stores/listings.ts`, the one copy every surface reads.
 * NOT `StoreReview.storeUrl()`: that reads `ios.appStoreUrl` /
 * `android.playStoreUrl` out of app.config.ts, which would be a second copy.
 * On iOS `action=write-review` opens straight into the review composer; Play has
 * no such deep link, and its listing carries the rating widget.
 */
export function storeReviewPageUrl(): string {
  return Platform.OS === 'ios' ? `${APP_STORE_URL}?action=write-review` : PLAY_STORE_URL;
}

/**
 * Open the store's review page, and stop asking on this device for good — the
 * user went there themselves, which is the nearest thing to "has rated" that
 * either store lets us see.
 */
export function openStoreReviewPage(): void {
  writeReviewPromptState({ ...readReviewPromptState(), openedStorePage: true });
  void Linking.openURL(storeReviewPageUrl()).catch(() => undefined);
}
