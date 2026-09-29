import { db } from './db';
import { markUpdateRequired, resetUpdateRequiredForTests } from './update-required';

afterEach(async () => {
  resetUpdateRequiredForTests();
  await db.open();
  await db.items.clear();
});

it('stops data writes when the session schema changes and refuses an explicit reopen', async () => {
  await db.items.put({ path: 'links/kept.enc', updatedAt: 1 });
  markUpdateRequired('session');

  await expect(db.items.put({ path: 'links/late.enc', updatedAt: 2 })).rejects.toThrow();
  await expect(db.open()).rejects.toThrow();

  resetUpdateRequiredForTests();
  await db.open();
  expect(await db.items.toArray()).toEqual([{ path: 'links/kept.enc', updatedAt: 1 }]);
});

it('refuses its first open when a schema change was already observed', async () => {
  db.close();
  markUpdateRequired('session');
  await expect(db.open()).rejects.toThrow();
});
