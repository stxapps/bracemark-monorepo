import { SESSION_RETENTION } from './sessions';

// The number and the words for it are two copies of one public promise, and
// nothing else compares them. Pinned together, so changing `days` fails here
// until someone has re-read `label` — and /privacy and /delete-account with it.
describe('session record retention', () => {
  it('says the number it keeps', () => {
    expect(SESSION_RETENTION).toEqual({ days: 365, label: 'a year' });
  });
});
