import * as React from 'react';
import { act, render } from '@testing-library/react-native';

import { useExtraction, useLiveRead, useSettingMutations, useSettings } from '@stxapps/expo-react';

import { PreviewsPrompt } from './previews-prompt';

// What this banner gets WRONG if nothing pins it: it counts links the save path
// on this very device is already fetching. At `saves` — the mode it arms on —
// `extractNow` fetches a link saved here outside the gate, so that link is
// raw-pending for the length of its own fetch and then settles itself. Counting
// it put the offer on screen for a few seconds after every save on a
// single-device account and then retired it, offering to cover a link that was
// already covered (docs/link-extraction.md — _the links-page offer_).
//
// Nothing else can catch that: both numbers are correct, the subtraction between
// them is the rule, and a wrong subtraction type-checks, lints and renders.
//
// The store seam is mocked whole, as this file's expo peers do — the counts and
// the live-read plumbing are spec'd in expo-react; what is under test here is
// the arithmetic and the settle window between them.
jest.mock('@stxapps/expo-react', () => ({
  readRawPendingTitleImageCount: jest.fn(),
  useExtraction: jest.fn(),
  useLiveRead: jest.fn(),
  useSettingMutations: jest.fn(),
  useSettings: jest.fn(),
}));

const useExtractionMock = useExtraction as jest.Mock;
const useLiveReadMock = useLiveRead as jest.Mock;
const useSettingMutationsMock = useSettingMutations as jest.Mock;
const useSettingsMock = useSettings as jest.Mock;

// Longer than the component's SETTLE_MS, so a test that advances by this has
// given the banner every chance to appear — which is what makes the negative
// case below mean "never" rather than "not yet".
const PAST_SETTLE_MS = 5_000;

// Read on every render, so assigning either mid-test is how a save "starts" and
// "finishes": the next render picks the new pair up, exactly as the live read
// and the extraction context deliver them.
let pending = 0;
let gesturedInFlightCount = 0;

const headline = (n: number) => `${n} link${n === 1 ? '' : 's'} without a preview`;

beforeEach(() => {
  jest.useFakeTimers();
  pending = 0;
  gesturedInFlightCount = 0;
  // The arming condition the banner exists for: the default nobody chose, on a
  // device that hasn't dismissed the offer.
  useSettingsMock.mockReturnValue({
    deviceExtractionMode: 'saves',
    previewsPromptDismissed: false,
  });
  useSettingMutationsMock.mockReturnValue({
    setDeviceExtractionMode: jest.fn().mockResolvedValue(undefined),
    dismissPreviewsPrompt: jest.fn().mockResolvedValue(undefined),
  });
  useLiveReadMock.mockImplementation(() => pending);
  useExtractionMock.mockImplementation(() => ({ gesturedInFlightCount }));
});

afterEach(() => {
  jest.useRealTimers();
});

// The positive control for the two negatives below: without it, a component that
// never rendered anything under any condition would pass them both.
test('offers to cover links the drain will never reach, once the count settles', () => {
  pending = 3;

  const { queryByText, getByText } = render(<PreviewsPrompt />);
  expect(queryByText(headline(3))).toBeNull();

  act(() => {
    jest.advanceTimersByTime(PAST_SETTLE_MS);
  });
  expect(getByText(headline(3))).toBeTruthy();
});

test('stays hidden while the save path is fetching everything that is pending', () => {
  // One link, saved on this device a moment ago: pending because its own fetch
  // hasn't landed, and owned by the gesture that made it.
  pending = 1;
  gesturedInFlightCount = 1;

  const { queryByText } = render(<PreviewsPrompt />);
  act(() => {
    jest.advanceTimersByTime(PAST_SETTLE_MS);
  });

  expect(queryByText(headline(1))).toBeNull();
  expect(queryByText(headline(0))).toBeNull();
});

test('counts only the links the save path does not own', () => {
  // A real backlog of two, plus a save in flight on top of it. The offer is
  // about the two; quoting three would promise to cover a link that is already
  // being covered.
  pending = 3;
  gesturedInFlightCount = 1;

  const { getByText } = render(<PreviewsPrompt />);
  act(() => {
    jest.advanceTimersByTime(PAST_SETTLE_MS);
  });

  expect(getByText(headline(2))).toBeTruthy();
});

test('a link arriving mid-wait does not restart the wait', () => {
  // The settle window is there to absorb the ORDER two independent updates land
  // in, not to make the banner wait out every later arrival — keying it on the
  // count itself would push the offer back a full window on each synced link,
  // which on a phone syncing an existing library is indefinitely.
  pending = 1;

  const { getByText, rerender } = render(<PreviewsPrompt />);
  act(() => {
    jest.advanceTimersByTime(1_500);
  });

  pending = 2;
  rerender(<PreviewsPrompt />);
  act(() => {
    jest.advanceTimersByTime(600);
  });

  expect(getByText(headline(2))).toBeTruthy();
});
