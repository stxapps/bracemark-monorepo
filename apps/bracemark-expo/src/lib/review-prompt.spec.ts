import type { ReviewPromptValue } from '@stxapps/expo-react';
import { APP_STORE_URL, PLAY_STORE_URL } from '@stxapps/shared';

import {
  ASK_DELAY_MS,
  DAYS_BETWEEN_ASKS,
  MAX_ASKS,
  nextReviewPromptState,
  noteReviewMoment,
  openStoreReviewPage,
  SAVES_BEFORE_ASKING,
  storeReviewPageUrl,
} from './review-prompt';

const mockRequestReview = jest.fn<Promise<void>, []>();
const mockOpenURL = jest.fn<Promise<void>, [string]>();
let mockOS = 'ios';
let mockAppState = 'active';
let mockStored: ReviewPromptValue;

jest.mock('react-native', () => ({
  // Getters: the factory runs at import, before this file's `let`s initialise.
  AppState: {
    get currentState() {
      return mockAppState;
    },
  },
  Linking: { openURL: (url: string) => mockOpenURL(url) },
  Platform: {
    get OS() {
      return mockOS;
    },
  },
}));

jest.mock('expo-store-review', () => ({
  requestReview: () => mockRequestReview(),
}));

jest.mock('@stxapps/expo-react', () => ({
  countReviewPromptSave: () => {
    mockStored = { ...mockStored, savesSinceAsk: mockStored.savesSinceAsk + 1 };
  },
  readReviewPromptState: () => mockStored,
  writeReviewPromptState: (value: ReviewPromptValue) => {
    mockStored = value;
  },
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const NEVER: ReviewPromptValue = {
  savesSinceAsk: 0,
  lastAskedAt: null,
  askCount: 0,
  openedStorePage: false,
};
// One save short of the ask, on a device that has never been asked — what the
// store holds BEFORE the save `noteReviewMoment` is about to count.
const DUE: ReviewPromptValue = { ...NEVER, savesSinceAsk: SAVES_BEFORE_ASKING - 1 };
// The same device with that save counted — what `nextReviewPromptState` is handed.
const EARNED: ReviewPromptValue = { ...NEVER, savesSinceAsk: SAVES_BEFORE_ASKING };

describe('nextReviewPromptState', () => {
  it('does not ask before the Nth save, and leaves the row as it was', () => {
    const { state, ask } = nextReviewPromptState(DUE, NOW);
    expect(ask).toBe(false);
    expect(state).toEqual(DUE);
  });

  it('asks on the Nth save, starts the count over and counts the ask', () => {
    const { state, ask } = nextReviewPromptState(EARNED, NOW);
    expect(ask).toBe(true);
    expect(state).toEqual({ ...NEVER, savesSinceAsk: 0, lastAskedAt: NOW, askCount: 1 });
  });

  // Share-sheet saves are counted as they land (share-store) and never ask
  // themselves, so a device can arrive here well past the Nth save.
  it('asks on the next save in the app once share saves have passed the Nth', () => {
    const state = { ...NEVER, savesSinceAsk: SAVES_BEFORE_ASKING * 3 };
    expect(nextReviewPromptState(state, NOW).ask).toBe(true);
  });

  it('holds inside the window after an ask', () => {
    const asked = NOW - (DAYS_BETWEEN_ASKS * DAY_MS - 1);
    const busy = { ...NEVER, savesSinceAsk: SAVES_BEFORE_ASKING * 3, lastAskedAt: asked };
    expect(nextReviewPromptState(busy, NOW).ask).toBe(false);
  });

  it('asks again once the window has passed and the saves are earned', () => {
    const asked = NOW - DAYS_BETWEEN_ASKS * DAY_MS;
    const state = { ...EARNED, lastAskedAt: asked, askCount: 1 };
    expect(nextReviewPromptState(state, NOW).ask).toBe(true);
  });

  // A clock that moved backwards must not park the prompt until it catches up.
  it('treats an ask stamped in the future as rested', () => {
    const state = { ...EARNED, lastAskedAt: NOW + 30 * DAY_MS };
    expect(nextReviewPromptState(state, NOW).ask).toBe(true);
  });

  // Neither store says whether the user rated, so the cap stands in for it.
  it('stops asking at the cap, however rested and earned', () => {
    const capped = { ...EARNED, lastAskedAt: NOW - 365 * DAY_MS, askCount: MAX_ASKS };
    const { state, ask } = nextReviewPromptState(capped, NOW);
    expect(ask).toBe(false);
    expect(state.askCount).toBe(MAX_ASKS);
  });

  it('never asks once the user opened the store page themselves', () => {
    expect(nextReviewPromptState({ ...EARNED, openedStorePage: true }, NOW).ask).toBe(false);
  });

  // The rules as one sign-in lives them: a save a day, for longer than the cap
  // lasts. Each case above holds one rule still; none of them shows the rules
  // agreeing — that the LAST allowed ask is made rather than the cap landing one
  // short, and that saves made inside the window are already earned when it ends,
  // so the next ask comes a window later and not a window plus N saves.
  it('asks MAX_ASKS times and no more, one window apart', () => {
    const window = Math.max(DAYS_BETWEEN_ASKS, SAVES_BEFORE_ASKING);
    const askedOnDay: number[] = [];
    let state = NEVER;
    for (let day = 0; day < (MAX_ASKS + 2) * window; day++) {
      const counted = { ...state, savesSinceAsk: state.savesSinceAsk + 1 };
      const next = nextReviewPromptState(counted, NOW + day * DAY_MS);
      if (next.ask) askedOnDay.push(day);
      state = next.state;
    }

    expect(askedOnDay).toEqual(
      Array.from({ length: MAX_ASKS }, (_, i) => SAVES_BEFORE_ASKING - 1 + i * window),
    );
  });
});

describe('noteReviewMoment', () => {
  // `__DEV__` is a read-only global in the RN typings, and a plain global in jest.
  const globals = globalThis as unknown as { __DEV__: boolean };
  const dev = globals.__DEV__;

  beforeEach(() => {
    jest.useFakeTimers();
    mockRequestReview.mockReset().mockResolvedValue(undefined);
    mockAppState = 'active';
    mockStored = NEVER;
    globals.__DEV__ = false;
  });

  afterEach(() => {
    jest.useRealTimers();
    globals.__DEV__ = dev;
  });

  // The ask is recorded when it is made: until the timer fires the row holds a
  // counted save and nothing else.
  it('asks a beat after the save, not during it', () => {
    mockStored = DUE;
    noteReviewMoment();

    expect(mockRequestReview).not.toHaveBeenCalled();
    expect(mockStored).toEqual(EARNED);
    jest.advanceTimersByTime(ASK_DELAY_MS);
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
    expect(mockStored).toEqual({ ...NEVER, lastAskedAt: Date.now(), askCount: 1 });
  });

  it('persists the count without asking when the save is not earned', () => {
    noteReviewMoment();

    jest.runAllTimers();
    expect(mockRequestReview).not.toHaveBeenCalled();
    expect(mockStored).toEqual({ ...NEVER, savesSinceAsk: 1 });
  });

  // Both saves have earned the ask and both set a timer. Each timer decides again
  // against the row as it stands, so the first to fire records the ask and the
  // second finds it resting — otherwise the OS is asked twice in two seconds.
  it('asks once when a second save lands inside the delay', () => {
    mockStored = DUE;

    noteReviewMoment();
    noteReviewMoment();
    jest.runAllTimers();

    expect(mockRequestReview).toHaveBeenCalledTimes(1);
    expect(mockStored).toMatchObject({ savesSinceAsk: 0, askCount: 1 });
  });

  // Paste, save, back to the browser: the user is gone before the delay is up.
  // iOS would reject the request for want of a foreground scene, so recording the
  // ask at the save spent one of MAX_ASKS and a whole window on a request the OS
  // never saw. Held instead: nothing asked, nothing recorded, and the saves stay
  // earned — so the ask comes on the next save the user is still here for.
  it.each(['background', 'inactive'])(
    'holds the ask when the app is %s as the delay ends, and asks on the next save',
    (appState) => {
      mockStored = DUE;
      noteReviewMoment();
      mockAppState = appState;
      jest.runAllTimers();

      expect(mockRequestReview).not.toHaveBeenCalled();
      expect(mockStored).toEqual(EARNED);

      mockAppState = 'active';
      noteReviewMoment();
      jest.runAllTimers();

      expect(mockRequestReview).toHaveBeenCalledTimes(1);
      expect(mockStored).toMatchObject({ savesSinceAsk: 0, askCount: 1 });
    },
  );

  // No foreground scene on iOS, a failed Play task — the save it rides on already
  // succeeded, and an unhandled rejection here would surface as a red box for nothing.
  it('swallows a rejected request', async () => {
    mockRequestReview.mockRejectedValue(new Error('no foreground scene'));
    mockStored = DUE;

    noteReviewMoment();
    jest.advanceTimersByTime(ASK_DELAY_MS);
    await Promise.resolve();

    expect(mockRequestReview).toHaveBeenCalledTimes(1);
  });

  // The iOS simulator shows the sheet on every call in a development build, which
  // would land in the middle of the Maestro flows.
  it('never asks, or counts, in a development build', () => {
    globals.__DEV__ = true;
    mockStored = DUE;

    noteReviewMoment();
    jest.runAllTimers();

    expect(mockRequestReview).not.toHaveBeenCalled();
    expect(mockStored).toEqual(DUE);
  });
});

describe('the store review page', () => {
  beforeEach(() => {
    mockOpenURL.mockReset().mockResolvedValue(undefined);
    mockOS = 'ios';
    mockStored = NEVER;
  });

  it('opens the review composer on iOS', () => {
    expect(storeReviewPageUrl()).toBe(`${APP_STORE_URL}?action=write-review`);
  });

  it('opens the listing itself on Android, which has no composer link', () => {
    mockOS = 'android';
    expect(storeReviewPageUrl()).toBe(PLAY_STORE_URL);
  });

  it('retires the automatic prompt when the user opens it', () => {
    mockStored = DUE;

    openStoreReviewPage();

    expect(mockOpenURL).toHaveBeenCalledWith(`${APP_STORE_URL}?action=write-review`);
    expect(mockStored).toEqual({ ...DUE, openedStorePage: true });
  });

  // Nothing on the device takes the link — a sideloaded Android build with no
  // Play Store. The row is a plain `onPress`, so nothing awaits this promise.
  it('swallows a link the device cannot open', async () => {
    mockOpenURL.mockRejectedValue(new Error('no activity found to handle the intent'));

    openStoreReviewPage();
    await Promise.resolve();

    expect(mockOpenURL).toHaveBeenCalledTimes(1);
  });
});
