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
// stand in for that answer: MAX_ASKS asks, and none at all once the user opened
// the store's review page themselves from Settings → About
// (`openStoreReviewPage`) — the one signal we CAN see. Both last UNTIL SIGN-OUT,
// not for the life of the install: the bookkeeping is a row in the device store,
// and sign-out wipes that store whole (expo-react `clear-data.ts`), so the next
// sign-in starts from never-asked. The OS's own cap is per install and does not
// start over, which is what keeps that reset cheap.
//
// The ask is recorded when it is MADE, not when it is decided. A save that earns
// one sets a timer (ASK_DELAY_MS), and by the time it fires the user may have
// left — paste, save, back to the browser. Then nothing is asked and nothing is
// recorded: the saves stay earned, and the next save in the app asks instead.
// Recording at the save spent one of MAX_ASKS and a whole DAYS_BETWEEN_ASKS on a
// request the OS never saw.
//
// `__DEV__` builds never ask. The iOS simulator shows the sheet on EVERY call in
// a development build, which would land in the middle of the Maestro flows that
// save more than a handful of links. To see it, run a release build
// (docs/expo-dependencies.md, _expo-store-review_). The gate is the BUNDLE's, not
// the binary's: `measure:data:ios` serves a `--no-dev` bundle to the development
// client, so there the prompt is live on a simulator that shows every ask
// (docs/e2e.md, _the native leg_).

import { AppState, Linking, Platform } from 'react-native';
import * as StoreReview from 'expo-store-review';

import {
  countReviewPromptSave,
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
 * Whether to ask now, and the bookkeeping if we do. Pure, so the rules above are
 * testable without a device.
 *
 * `state` already counts the save that brought us here — counting is the store's
 * (`countReviewPromptSave`, the one spelling the add panel and the share sheet
 * share), and this decides what a counted row has earned. With no ask the row
 * comes back as it went in.
 *
 * `lastAskedAt` is reset when we ASK, not when a sheet shows — nothing reports
 * that. A `lastAskedAt` in the future means the clock moved backwards since;
 * that counts as rested rather than blocking asks until the clock catches up.
 */
export function nextReviewPromptState(
  state: ReviewPromptValue,
  now: number,
): { state: ReviewPromptValue; ask: boolean } {
  const done = state.openedStorePage || state.askCount >= MAX_ASKS;
  const rested =
    state.lastAskedAt === null ||
    now < state.lastAskedAt ||
    now - state.lastAskedAt >= DAYS_BETWEEN_ASKS * DAY_MS;
  const earned = state.savesSinceAsk >= SAVES_BEFORE_ASKING;

  if (!done && rested && earned) {
    return {
      state: { ...state, savesSinceAsk: 0, lastAskedAt: now, askCount: state.askCount + 1 },
      ask: true,
    };
  }
  return { state, ask: false };
}

/**
 * Record a link saved from the add panel and, if it is time, ask for a review a
 * beat later. Fire-and-forget: it never throws and never delays the caller's
 * success path.
 *
 * `requestReview` directly, NOT gated on `isAvailableAsync`, because that check
 * answers nothing the request doesn't. On iOS it is "not TestFlight", where the
 * request is ignored anyway. On Android it is "the Play Store package is visible
 * to us" — true on a Play install (an app's installer is always visible to it,
 * `<queries>` or not) and false on a sideload, where Play's flow resolves
 * without UI anyway. Neither says whether a sheet will show; only the OS's quota
 * does. It rejects on a failed Play task, or with no foreground scene on iOS in
 * the instant after the check below — swallowed either way, and by then the ask
 * is recorded, which is the right side to err on.
 */
export function noteReviewMoment(): void {
  if (__DEV__) return;

  countReviewPromptSave();
  // Decided here only to spare every other save a timer; the decision that
  // counts is the one below.
  if (!nextReviewPromptState(readReviewPromptState(), Date.now()).ask) return;

  setTimeout(() => {
    // Gone during the delay: hold the ask rather than spend it (see the header).
    // 'inactive' holds too — the app switcher, a system dialog over the app.
    if (AppState.currentState !== 'active') return;

    // Decided again, against the row as it stands NOW. A second save inside the
    // delay set a timer of its own, and whichever fires first records the ask —
    // the other finds the row resting and stops here.
    const { state, ask } = nextReviewPromptState(readReviewPromptState(), Date.now());
    if (!ask) return;
    writeReviewPromptState(state);
    StoreReview.requestReview().catch(() => {
      // No sheet this time; the ask is recorded either way (see above).
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
 * Open the store's review page, and stop asking — the user went there
 * themselves, which is the nearest thing to "has rated" that either store lets
 * us see. Until sign-out, like the rest of the bookkeeping (see the header).
 */
export function openStoreReviewPage(): void {
  writeReviewPromptState({ ...readReviewPromptState(), openedStorePage: true });
  void Linking.openURL(storeReviewPageUrl()).catch(() => undefined);
}
