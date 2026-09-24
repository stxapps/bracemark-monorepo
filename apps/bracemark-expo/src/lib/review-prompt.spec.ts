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
let mockStored: ReviewPromptValue;

jest.mock('react-native', () => ({
  Linking: { openURL: (url: string) => mockOpenURL(url) },
  // A getter: the factory runs at import, before this file's `let`s initialise.
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
// One save short of the ask, on a device that has never been asked.
const DUE: ReviewPromptValue = { ...NEVER, savesSinceAsk: SAVES_BEFORE_ASKING - 1 };

describe('nextReviewPromptState', () => {
  it('does not ask before the Nth save, and counts toward it', () => {
    const { state, ask } = nextReviewPromptState(
      { ...NEVER, savesSinceAsk: SAVES_BEFORE_ASKING - 2 },
      NOW,
    );
    expect(ask).toBe(false);
    expect(state).toEqual({ ...NEVER, savesSinceAsk: SAVES_BEFORE_ASKING - 1 });
  });

  it('asks on the Nth save, starts the count over and counts the ask', () => {
    const { state, ask } = nextReviewPromptState(DUE, NOW);
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
    expect(nextReviewPromptState({ ...DUE, lastAskedAt: asked, askCount: 1 }, NOW).ask).toBe(true);
  });

  // A clock that moved backwards must not park the prompt until it catches up.
  it('treats an ask stamped in the future as rested', () => {
    expect(nextReviewPromptState({ ...DUE, lastAskedAt: NOW + 30 * DAY_MS }, NOW).ask).toBe(true);
  });

  // Neither store says whether the user rated, so the cap stands in for it.
  it('stops asking after the lifetime cap, however rested and earned', () => {
    const capped = { ...DUE, lastAskedAt: NOW - 365 * DAY_MS, askCount: MAX_ASKS };
    const { state, ask } = nextReviewPromptState(capped, NOW);
    expect(ask).toBe(false);
    expect(state.askCount).toBe(MAX_ASKS);
  });

  it('never asks once the user opened the store page themselves', () => {
    expect(nextReviewPromptState({ ...DUE, openedStorePage: true }, NOW).ask).toBe(false);
  });
});

describe('noteReviewMoment', () => {
  // `__DEV__` is a read-only global in the RN typings, and a plain global in jest.
  const globals = globalThis as unknown as { __DEV__: boolean };
  const dev = globals.__DEV__;

  beforeEach(() => {
    jest.useFakeTimers();
    mockRequestReview.mockReset().mockResolvedValue(undefined);
    mockStored = NEVER;
    globals.__DEV__ = false;
  });

  afterEach(() => {
    jest.useRealTimers();
    globals.__DEV__ = dev;
  });

  it('asks a beat after the save, not during it', () => {
    mockStored = DUE;
    noteReviewMoment();

    expect(mockRequestReview).not.toHaveBeenCalled();
    jest.advanceTimersByTime(ASK_DELAY_MS);
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
    expect(mockStored.lastAskedAt).not.toBeNull();
  });

  it('persists the count without asking when the save is not earned', () => {
    noteReviewMoment();

    jest.runAllTimers();
    expect(mockRequestReview).not.toHaveBeenCalled();
    expect(mockStored).toEqual({ ...NEVER, savesSinceAsk: 1 });
  });

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
});
