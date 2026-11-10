import { entitlementsOf } from './plans';
import { formatStorageBytes, formatStorageCeiling, isPublishedStorageCeiling } from './storage';

// The pricing page prints a ceiling with formatStorageCeiling and the app prints
// usage against it with formatStorageBytes, so the two have to agree on units and
// the ceiling must never read as more than the server allows. Nothing on screen
// would show a disagreement until a user hit "storage full" at "4.8 of 5 GB".

describe('formatStorageCeiling', () => {
  it('prints Plus’s ceiling as the whole number it was defined as', () => {
    expect(formatStorageCeiling(entitlementsOf('plus').maxBytes)).toBe('5 GB');
  });

  it('rounds down, never up — the printed number is a promise', () => {
    expect(formatStorageCeiling(5.9 * 1024 ** 3)).toBe('5 GB');
    expect(formatStorageCeiling(100 * 1024 ** 2)).toBe('100 MB');
  });
});

describe('formatStorageBytes', () => {
  it.each([
    [0, '0 KB'],
    [512, '0 KB'],
    [1024, '1 KB'],
    [48 * 1024, '48 KB'],
    [3.44 * 1024 ** 2, '3.4 MB'],
    [830 * 1024 ** 2, '830 MB'],
    [1.25 * 1024 ** 3, '1.2 GB'],
    [12.4 * 1024 ** 3, '12 GB'],
  ])('%d bytes reads %s', (bytes, shown) => {
    expect(formatStorageBytes(bytes)).toBe(shown);
  });

  // Rounded DOWN, as the ceiling is. To nearest, the last stretch below the
  // ceiling read "5 GB of 5 GB used" over a bar that was not full, and the top
  // of a unit printed as 1024 of it.
  it.each([
    [5 * 1024 ** 3 - 1, '4.9 GB'],
    [4.96 * 1024 ** 3, '4.9 GB'],
    [9.99 * 1024 ** 2, '9.9 MB'],
    [1024 ** 2 - 1, '1023 KB'],
    [1024 ** 3 - 1, '1023 MB'],
  ])('%d bytes rounds down to %s, never up to the next figure', (bytes, shown) => {
    expect(formatStorageBytes(bytes)).toBe(shown);
  });

  it('drops a trailing .0, so a full Plus library reads like its ceiling', () => {
    expect(formatStorageBytes(entitlementsOf('plus').maxBytes)).toBe('5 GB');
  });
});

describe('isPublishedStorageCeiling', () => {
  it('publishes the ceilings of the plans that keep copies', () => {
    expect(isPublishedStorageCeiling(entitlementsOf('plus').maxBytes)).toBe(true);
    expect(isPublishedStorageCeiling(entitlementsOf('pro').maxBytes)).toBe(true);
  });

  it('keeps Free’s unpublished, in the app as on the pricing page', () => {
    expect(isPublishedStorageCeiling(entitlementsOf('free').maxBytes)).toBe(false);
  });
});
