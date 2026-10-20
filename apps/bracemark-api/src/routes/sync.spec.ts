import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import {
  entitlementsOf,
  filesListEndpoint,
  filesSignEndpoint,
  opsCommitEndpoint,
  opsListEndpoint,
} from '@stxapps/shared';

import { app } from '../app';
import { purchasesRepo } from '../db/repositories/purchases';
import { userDataStub } from '../do/user-data';
import { newId } from '../lib/ids';
import { userFileKey } from '../r2/keys';
import { issueSession } from '../services/session';

// End-to-end coverage of the four-endpoint sync control plane through the real
// Hono app + the real (miniflare) bindings: a per-user Durable Object op log and
// R2. The app is driven exactly as a client would via app.request(path, init,
// env) with a real bearer token (issueSession), so requireAuth, the contract
// validation, and the per-user path namespacing are all exercised. Because the
// test env IS the local `development` env (placeholder R2_ACCOUNT_ID), files/sign
// returns dev blob-proxy URLs, not SigV4 presigns — the proxy round-trip is
// covered below; the SigV4 presigner has its own unit test (r2/presign.spec.ts).
// See docs/local-first-sync.md, r2/local.ts, and routes/local-r2.ts.
describe('sync control plane', () => {
  // Mint a real session and return the userId + the Authorization header a client
  // would send. The session's userId IS the per-user DO / R2-prefix key.
  async function authFor(
    userId: string,
  ): Promise<{ userId: string; auth: Record<string, string> }> {
    const { token } = await issueSession(env, { id: userId, accountDbId: '1' });
    return { userId, auth: { authorization: `Bearer ${token}` } };
  }

  const json = (auth: Record<string, string>, body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(body),
  });

  // Entitle a test account: the `files/sign` put gate is plan-aware (an account
  // with no purchase row is FREE — no `files/` blobs), so tests exercising blob
  // paths grant a plan first via a non-expiring 'manual' purchase.
  async function grantPlan(userId: string, plan: 'plus' | 'pro'): Promise<void> {
    await purchasesRepo(env.DIRECTORY_DB).upsertFromProvider({
      id: newId(),
      userId,
      source: 'manual',
      externalId: `test-grant-${userId}`,
      plan,
      status: 'active',
      providerCustomerId: null,
      expiresAt: null,
      canceledAt: null,
      eventOccurredAt: Date.now(),
    });
  }

  describe('auth', () => {
    it('rejects every endpoint without a bearer token (401)', async () => {
      const get = (path: string) => app.request(path, {}, env);
      expect((await get(opsListEndpoint.path)).status).toBe(401);
      expect((await get(filesListEndpoint.path)).status).toBe(401);
      expect(
        (
          await app.request(
            opsCommitEndpoint.path,
            json({}, { ops: [{ op: 'put', path: 'links/a.enc' }] }),
            env,
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await app.request(
            filesSignEndpoint.path,
            json({}, { op: 'get', paths: ['links/a.enc'] }),
            env,
          )
        ).status,
      ).toBe(401);
    });
  });

  describe(`POST ${opsCommitEndpoint.path} + GET ${opsListEndpoint.path}`, () => {
    it('commits a put and pulls it back over the op list', async () => {
      const { userId, auth } = await authFor('sync-commit-1');
      // The client PUTs the blob to R2 first (here directly), then commits.
      await env.USER_FILES.put(userFileKey(userId, 'links/m1.enc'), 'ciphertext');

      const commit = await app.request(
        opsCommitEndpoint.path,
        json(auth, { ops: [{ op: 'put', path: 'links/m1.enc' }] }),
        env,
      );
      expect(commit.status).toBe(200);
      const { results, failed } = (await commit.json()) as {
        results: { path: string; updatedAt: number }[];
        failed: { path: string; reason: string }[];
      };
      expect(failed).toEqual([]);
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe('links/m1.enc');
      expect(typeof results[0].updatedAt).toBe('number');
      // Commit recorded R2's own LastModified.
      const head = await env.USER_FILES.head(userFileKey(userId, 'links/m1.enc'));
      expect(results[0].updatedAt).toBe(head?.uploaded.getTime());

      const list = await app.request(`${opsListEndpoint.path}`, { headers: auth }, env);
      expect(list.status).toBe(200);
      const pulled = (await list.json()) as {
        ops: { op: string; path: string; updatedAt: number }[];
        oldestUpdatedAt: number | null;
        newestUpdatedAt: number | null;
        hasMore: boolean;
      };
      expect(pulled.ops).toEqual([
        { op: 'put', path: 'links/m1.enc', updatedAt: results[0].updatedAt },
      ]);
      expect(pulled.newestUpdatedAt).toBe(results[0].updatedAt);
      expect(pulled.hasMore).toBe(false);
    });

    it('commits a batch and reports puts whose R2 object is missing in failed', async () => {
      const { userId, auth } = await authFor('sync-commit-batch-1');
      // Two of the three puts have objects in R2; the third never landed.
      await env.USER_FILES.put(userFileKey(userId, 'links/a.enc'), 'aa');
      await env.USER_FILES.put(userFileKey(userId, 'files/b.enc'), 'bb');

      const commit = await app.request(
        opsCommitEndpoint.path,
        json(auth, {
          ops: [
            { op: 'put', path: 'links/a.enc' },
            { op: 'put', path: 'links/missing.enc' },
            { op: 'put', path: 'files/b.enc' },
          ],
        }),
        env,
      );
      expect(commit.status).toBe(200);
      const { results, failed } = (await commit.json()) as {
        results: { path: string; updatedAt: number }[];
        failed: { path: string; reason: string }[];
      };
      // The two real objects commit; the missing path is reported in failed.
      expect(results.map((r) => r.path).sort()).toEqual(['files/b.enc', 'links/a.enc']);
      expect(failed).toEqual([{ path: 'links/missing.enc', reason: 'no_object' }]);

      const list = await app.request(opsListEndpoint.path, { headers: auth }, env);
      const pulled = (await list.json()) as { ops: { path: string }[] };
      expect(pulled.ops.map((o) => o.path).sort()).toEqual(['files/b.enc', 'links/a.enc']);
    });

    // Big enough that the existence check lists instead of HEADing (r2/user-files.ts
    // statMany): the answer must be the one a HEAD per put gave — R2's own stamp
    // per committed path, and the missing one refused.
    it('commits a dense batch with R2’s own stamps, refusing the one never uploaded', async () => {
      const { userId, auth } = await authFor('sync-commit-dense-1');
      const paths = Array.from(
        { length: 40 },
        (_, n) => `links/d-${String(n).padStart(3, '0')}.enc`,
      );
      const missing = paths[17];
      await Promise.all(
        paths
          .filter((p) => p !== missing)
          .map((p) => env.USER_FILES.put(userFileKey(userId, p), 'ciphertext')),
      );

      const commit = await app.request(
        opsCommitEndpoint.path,
        json(auth, { ops: paths.map((path) => ({ op: 'put', path })) }),
        env,
      );
      const { results, failed } = (await commit.json()) as {
        results: { path: string; updatedAt: number }[];
        failed: { path: string; reason: string }[];
      };

      expect(failed).toEqual([{ path: missing, reason: 'no_object' }]);
      expect(results).toHaveLength(39);
      // Every stamp is R2's LastModified, or the clamp's lift above the log —
      // never below what R2 recorded.
      for (const r of results) {
        const head = await env.USER_FILES.head(userFileKey(userId, r.path));
        expect(r.updatedAt).toBeGreaterThanOrEqual(head?.uploaded.getTime() ?? Infinity);
      }
    });

    it('commits a delete: removes the R2 object, logs the op, frees the listing', async () => {
      const { userId, auth } = await authFor('sync-delete-1');
      // Put-then-commit so the object, its op, and its quota entry all exist.
      await env.USER_FILES.put(userFileKey(userId, 'links/d1.enc'), 'ciphertext');
      await app.request(
        opsCommitEndpoint.path,
        json(auth, { ops: [{ op: 'put', path: 'links/d1.enc' }] }),
        env,
      );

      const commit = await app.request(
        opsCommitEndpoint.path,
        json(auth, { ops: [{ op: 'delete', path: 'links/d1.enc' }] }),
        env,
      );
      expect(commit.status).toBe(200);
      const { results, failed } = (await commit.json()) as {
        results: { path: string; updatedAt: number }[];
        failed: unknown[];
      };
      expect(failed).toEqual([]);
      expect(results.map((r) => r.path)).toEqual(['links/d1.enc']);

      // The object is GONE from R2 — the server deletes it at commit (the client
      // can't: files/sign mints only PUT/GET URLs). R2 is truth, so without this
      // the download-authoritative fallback would resurrect every deleted file.
      await expect(env.USER_FILES.head(userFileKey(userId, 'links/d1.enc'))).resolves.toBeNull();
      const listing = await app.request(filesListEndpoint.path, { headers: auth }, env);
      expect(((await listing.json()) as { files: unknown[] }).files).toEqual([]);

      // Both ops are in the log; the delete is stamped on the commit clock.
      const list = await app.request(opsListEndpoint.path, { headers: auth }, env);
      const pulled = (await list.json()) as { ops: { op: string; path: string }[] };
      expect(pulled.ops.map((o) => o.op)).toEqual(['put', 'delete']);

      // Re-committing the delete is idempotent — the absent key is a no-op.
      const again = await app.request(
        opsCommitEndpoint.path,
        json(auth, { ops: [{ op: 'delete', path: 'links/d1.enc' }] }),
        env,
      );
      expect(again.status).toBe(200);
    });

    it('advances past the cursor and reports null bounds for a fresh user', async () => {
      const { auth } = await authFor('sync-fresh-1');
      const res = await app.request(opsListEndpoint.path, { headers: auth }, env);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        ops: [],
        oldestUpdatedAt: null,
        newestUpdatedAt: null,
        hasMore: false,
      });
    });

    it('rejects a malformed path at the contract boundary (400)', async () => {
      const { auth } = await authFor('sync-badpath-1');
      const res = await app.request(
        opsCommitEndpoint.path,
        json(auth, { ops: [{ op: 'put', path: '../../etc/passwd' }] }),
        env,
      );
      expect(res.status).toBe(400);
    });

    it('reports a put with no R2 object in failed without erroring (op-without-object invariant)', async () => {
      // The service HEADs R2 before logging: a put for a path that isn't in R2 is
      // refused — the request still 200s with empty results, the path in failed,
      // and the log untouched, so no client ever pulls an op that 404s. (No
      // env.USER_FILES.put here — the object is absent.)
      const { auth } = await authFor('sync-noobject-1');
      const res = await app.request(
        opsCommitEndpoint.path,
        json(auth, { ops: [{ op: 'put', path: 'links/missing.enc' }] }),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        results: [],
        failed: [{ path: 'links/missing.enc', reason: 'no_object' }],
      });

      const list = await app.request(opsListEndpoint.path, { headers: auth }, env);
      expect(((await list.json()) as { ops: unknown[] }).ops).toHaveLength(0);
    });
  });

  describe(`GET ${filesListEndpoint.path}`, () => {
    it('lists only the calling user’s objects, with R2 timestamps', async () => {
      const { userId, auth } = await authFor('sync-list-1');
      await env.USER_FILES.put(userFileKey(userId, 'links/x.enc'), 'x');
      await env.USER_FILES.put(userFileKey(userId, 'tags/t.enc'), 'tt');
      // Another user's object must NOT appear.
      await env.USER_FILES.put(userFileKey('sync-list-other', 'links/y.enc'), 'y');

      const res = await app.request(filesListEndpoint.path, { headers: auth }, env);
      expect(res.status).toBe(200);
      const { files, nextPageToken } = (await res.json()) as {
        files: { path: string; updatedAt: number }[];
        nextPageToken: string | null;
      };
      expect(files.map((f) => f.path).sort()).toEqual(['links/x.enc', 'tags/t.enc']);
      expect(files.every((f) => typeof f.updatedAt === 'number')).toBe(true);
      // Two objects, well under the page limit, so the listing is complete.
      expect(nextPageToken).toBeNull();
    });

    it('pages the listing when more objects remain than the limit', async () => {
      const { userId, auth } = await authFor('sync-list-page-1');
      for (const id of ['a', 'b', 'c']) {
        await env.USER_FILES.put(userFileKey(userId, `links/${id}.enc`), id);
      }

      // limit=2 over 3 objects ⇒ first page is full and carries a nextPageToken.
      const first = await app.request(`${filesListEndpoint.path}?limit=2`, { headers: auth }, env);
      const page1 = (await first.json()) as {
        files: { path: string }[];
        nextPageToken: string | null;
      };
      expect(page1.files).toHaveLength(2);
      expect(typeof page1.nextPageToken).toBe('string');

      // Resume from the token ⇒ the remaining object, no more.
      const token = encodeURIComponent(page1.nextPageToken as string);
      const second = await app.request(
        `${filesListEndpoint.path}?limit=2&pageToken=${token}`,
        { headers: auth },
        env,
      );
      const page2 = (await second.json()) as {
        files: { path: string }[];
        nextPageToken: string | null;
      };
      expect(page2.files).toHaveLength(1);
      expect(page2.nextPageToken).toBeNull();

      // The two pages together cover every object exactly once.
      const all = [...page1.files, ...page2.files].map((f) => f.path).sort();
      expect(all).toEqual(['links/a.enc', 'links/b.enc', 'links/c.enc']);
    });

    // Page through a listing to its end, returning every page's paths.
    async function listAll(auth: Record<string, string>, limit: number): Promise<string[][]> {
      const pages: string[][] = [];
      let token: string | null = null;
      do {
        const query = `limit=${limit}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
        const res = await app.request(`${filesListEndpoint.path}?${query}`, { headers: auth }, env);
        expect(res.status).toBe(200);
        const page = (await res.json()) as {
          files: { path: string }[];
          nextPageToken: string | null;
        };
        pages.push(page.files.map((f) => f.path));
        token = page.nextPageToken;
      } while (token);
      return pages;
    }

    it('lists every namespace at once, a page of each per call', async () => {
      // The split (r2/user-files.ts listPage): a page holds up to `limit` keys of
      // EACH unfinished namespace, so the calls are as many as the largest
      // namespace needs, not as many as the whole prefix does.
      const { userId, auth } = await authFor('sync-list-split-1');
      const objects = [
        'links/a.enc',
        'links/b.enc',
        'links/c.enc',
        'tags/t1.enc',
        'tags/t2.enc',
        'tags/t3.enc',
        'files/f.enc',
        'settings/general.enc',
      ];
      for (const path of objects) await env.USER_FILES.put(userFileKey(userId, path), 'x');

      const pages = await listAll(auth, 2);

      expect(pages).toHaveLength(2);
      expect(pages[0]).toHaveLength(6);
      expect(pages.flat().sort()).toEqual([...objects].sort());
    });

    it('lists a namespace this server does not know, and a key outside any namespace', async () => {
      // The listing is download-authoritative: a path it leaves out is one every
      // client that takes a fallback drops locally. So which namespaces exist is
      // read from the bucket, never from the list this server was built with.
      const { userId, auth } = await authFor('sync-list-split-2');
      const objects = ['links/a.enc', 'notes/n1.enc', 'notes/n2.enc', 'notes/n3.enc', 'stray.enc'];
      for (const path of objects) await env.USER_FILES.put(userFileKey(userId, path), 'x');

      const pages = await listAll(auth, 2);

      expect(pages.flat().sort()).toEqual([...objects].sort());
    });

    it('lists the old way a prefix holding a namespace no token may name', async () => {
      const { userId, auth } = await authFor('sync-list-split-5');
      const objects = ['links/a.enc', 'links/b.enc', 'odd.ns/x.enc'];
      for (const path of objects) await env.USER_FILES.put(userFileKey(userId, path), 'x');

      const pages = await listAll(auth, 1);

      // One key a page: the whole prefix in key order, R2's own cursor between.
      expect(pages).toEqual([['links/a.enc'], ['links/b.enc'], ['odd.ns/x.enc']]);
    });

    it('finishes a listing whose token is from before the split', async () => {
      // A client paging across the deploy holds R2's own cursor over the whole
      // prefix; it is resumed the old way rather than refused.
      const { userId, auth } = await authFor('sync-list-split-3');
      const objects = ['links/a.enc', 'links/b.enc', 'tags/t.enc'];
      for (const path of objects) await env.USER_FILES.put(userFileKey(userId, path), 'x');
      const first = await env.USER_FILES.list({ prefix: `users/${userId}/`, limit: 1 });
      expect(first.truncated).toBe(true);
      const cursor = first.truncated ? first.cursor : '';

      const res = await app.request(
        `${filesListEndpoint.path}?limit=1000&pageToken=${encodeURIComponent(cursor)}`,
        { headers: auth },
        env,
      );
      const page = (await res.json()) as { files: { path: string }[]; nextPageToken: unknown };

      expect(page.files.map((f) => f.path).sort()).toEqual(['links/b.enc', 'tags/t.enc']);
      expect(page.nextPageToken).toBeNull();
    });

    it('refuses a split token it cannot read', async () => {
      const { auth } = await authFor('sync-list-split-4');
      const bad = encodeURIComponent(`~ns1~${btoa(JSON.stringify([['../', null]]))}`);

      const res = await app.request(
        `${filesListEndpoint.path}?pageToken=${bad}`,
        { headers: auth },
        env,
      );

      expect(res.status).toBe(400);
    });
  });

  describe(`POST ${filesSignEndpoint.path}`, () => {
    it('mints PUT URLs scoped to the user’s prefix', async () => {
      const { userId, auth } = await authFor('sync-sign-1');
      await grantPlan(userId, 'plus');
      const res = await app.request(
        filesSignEndpoint.path,
        json(auth, { op: 'put', paths: ['links/a.enc', 'files/b.enc'] }),
        env,
      );
      expect(res.status).toBe(200);
      const { urls } = (await res.json()) as { urls: { path: string; url: string }[] };
      expect(urls.map((u) => u.path)).toEqual(['links/a.enc', 'files/b.enc']);
      for (const { path, url } of urls) {
        // Dev env: the blob-proxy URL, keyed under users/{uid}/ (see routes/local-r2.ts).
        expect(url).toContain('/v1/files/blob/');
        expect(url).toContain(userFileKey(userId, path));
      }
    });

    it('free plan: signs files/ puts (preview images), links/ puts, and all gets', async () => {
      const { auth } = await authFor('sync-sign-free-1');

      // Free stores `files/` blobs now — client-extracted preview images. There
      // is no per-namespace plan gate (the server can't tell a preview image from
      // a heavy blob); free blob storage is bounded only by the byte/count
      // backstop, exercised as a pure function in lib/quota.spec.ts.
      const files = await app.request(
        filesSignEndpoint.path,
        json(auth, { op: 'put', paths: ['files/x.enc'] }),
        env,
      );
      expect(files.status).toBe(200);

      // Link metadata is writable too — the gate does not count links at all.
      const links = await app.request(
        filesSignEndpoint.path,
        json(auth, { op: 'put', paths: ['links/x.enc'] }),
        env,
      );
      expect(links.status).toBe(200);

      // GETs are never plan-gated — reading your own data survives a downgrade.
      const get = await app.request(
        filesSignEndpoint.path,
        json(auth, { op: 'get', paths: ['files/x.enc'] }),
        env,
      );
      expect(get.status).toBe(200);
    });

    // The gate is a byte/object backstop and nothing else. These two pin the
    // trade end-to-end: links are no longer counted at any volume, and the
    // ceiling that IS still enforced refuses through the real route.
    it('free plan far past the old 200-link cap: still signs new links', async () => {
      const { userId, auth } = await authFor('sync-sign-many-links');
      const cap = entitlementsOf('free').maxLinks ?? 0;
      // Seed straight into the DO's size map — well past the cap the free tier
      // advertises, the way an honor-system bypass or a downgrade leaves it.
      await userDataStub(env, userId).commitOps(
        Array.from({ length: cap * 2 }, (_, i) => ({
          op: 'put' as const,
          path: `links/seed-${i}.enc`,
          updatedAt: 1000 + i,
          size: 1,
        })),
      );

      const res = await app.request(
        filesSignEndpoint.path,
        json(auth, { op: 'put', paths: ['links/brand-new.enc'] }),
        env,
      );
      // The 200-link cap lives on the create surfaces now.
      // A client that ignores it is not stopped here — that is the accepted cost,
      // and this test exists so the change is deliberate rather than a regression.
      expect(res.status).toBe(200);
    });

    it('refuses a put once the byte ceiling is reached (quota_exceeded)', async () => {
      const { userId, auth } = await authFor('sync-sign-bytes-full');
      // One recorded object as large as the whole free allowance — the cheapest
      // way to put the account's byte total at its ceiling.
      await userDataStub(env, userId).commitOps([
        {
          op: 'put',
          path: 'files/huge.enc',
          updatedAt: 1000,
          size: entitlementsOf('free').maxBytes,
        },
      ]);

      const res = await app.request(
        filesSignEndpoint.path,
        json(auth, { op: 'put', paths: ['links/a.enc'] }),
        env,
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('quota_exceeded');

      // Reading and deleting survive being full — the read-only-plus-delete
      // promise (lib/quota.ts) is what keeps an over-quota account recoverable.
      const get = await app.request(
        filesSignEndpoint.path,
        json(auth, { op: 'get', paths: ['files/huge.enc'] }),
        env,
      );
      expect(get.status).toBe(200);
    });

    it('a LAPSED plus account keeps writing past the free ceiling', async () => {
      // The high-water rule through the real route: same usage as the test above
      // (exactly free's whole byte allowance), same free `plan` on iap/status —
      // but this account has a spent Plus row, so the gate sizes it against
      // Plus. Without this it would wake up read-only-plus-delete over a library
      // it uploaded while paying. See services/iap.ts foldQuotaCeilings.
      const { userId, auth } = await authFor('sync-sign-lapsed-plus');
      await purchasesRepo(env.DIRECTORY_DB).upsertFromProvider({
        id: newId(),
        userId,
        source: 'paddle',
        externalId: `test-lapsed-${userId}`,
        plan: 'plus',
        status: 'canceled',
        providerCustomerId: null,
        expiresAt: Date.now() - 24 * 60 * 60 * 1000,
        canceledAt: Date.now() - 24 * 60 * 60 * 1000,
        eventOccurredAt: Date.now(),
      });
      await userDataStub(env, userId).commitOps([
        {
          op: 'put',
          path: 'files/huge.enc',
          updatedAt: 1000,
          size: entitlementsOf('free').maxBytes,
        },
      ]);

      const res = await app.request(
        filesSignEndpoint.path,
        json(auth, { op: 'put', paths: ['links/still-editable.enc'] }),
        env,
      );
      expect(res.status).toBe(200);
    });

    it('mints GET URLs in batch', async () => {
      const { userId, auth } = await authFor('sync-sign-2');
      const res = await app.request(
        filesSignEndpoint.path,
        json(auth, { op: 'get', paths: ['links/a.enc'] }),
        env,
      );
      expect(res.status).toBe(200);
      const { urls } = (await res.json()) as { urls: { path: string; url: string }[] };
      expect(urls).toHaveLength(1);
      expect(urls[0].url).toContain(`/v1/files/blob/${userFileKey(userId, 'links/a.enc')}`);
    });

    it('round-trips a blob through the dev proxy (PUT then GET)', async () => {
      const { userId, auth } = await authFor('sync-sign-rt');
      // Sign a PUT, upload bytes to that URL, then sign+GET them back — exactly
      // the local stand-in for direct browser↔R2 transfer (routes/local-r2.ts).
      const signPut = await app.request(
        filesSignEndpoint.path,
        json(auth, { op: 'put', paths: ['links/rt.enc'] }),
        env,
      );
      const putUrl = ((await signPut.json()) as { urls: { url: string }[] }).urls[0].url;
      const put = await app.request(
        new URL(putUrl).pathname,
        { method: 'PUT', body: 'ciphertext' },
        env,
      );
      expect(put.status).toBe(200);
      // The proxy wrote through the binding to the user-namespaced key.
      expect(await env.USER_FILES.head(userFileKey(userId, 'links/rt.enc'))).not.toBeNull();

      const signGet = await app.request(
        filesSignEndpoint.path,
        json(auth, { op: 'get', paths: ['links/rt.enc'] }),
        env,
      );
      const getUrl = ((await signGet.json()) as { urls: { url: string }[] }).urls[0].url;
      const get = await app.request(new URL(getUrl).pathname, {}, env);
      expect(get.status).toBe(200);
      expect(await get.text()).toBe('ciphertext');
    });

    it('points dev blob URLs at the origin the client reached the api on', async () => {
      const { userId, auth } = await authFor('sync-sign-origin');
      // The one caller that is NOT on loopback: a physical iPhone, which cannot be
      // taught that localhost means the Mac (no `adb reverse` equivalent) and so
      // addresses the Mac by LAN IP — `wrangler dev` binds 0.0.0.0 for exactly this.
      // A hardcoded `http://localhost:8787` here would be handed back to the phone
      // and resolve to the PHONE: sync mints URLs, every blob transfer then fails
      // with a connection refused. Nothing else in this suite leaves loopback.
      const res = await app.request(
        `http://192.0.2.10:8787${filesSignEndpoint.path}`,
        json(auth, { op: 'get', paths: ['links/a.enc'] }),
        env,
      );

      expect(res.status).toBe(200);
      const { urls } = (await res.json()) as { urls: { url: string }[] };
      expect(new URL(urls[0].url).origin).toBe('http://192.0.2.10:8787');
      expect(new URL(urls[0].url).pathname).toBe(
        `/v1/files/blob/${userFileKey(userId, 'links/a.enc')}`,
      );
    });

    it('returns 404 for a missing blob through the dev proxy', async () => {
      const { userId } = await authFor('sync-sign-404');
      const get = await app.request(
        `/v1/files/blob/${userFileKey(userId, 'links/nope.enc')}`,
        {},
        env,
      );
      expect(get.status).toBe(404);
    });

    it('rejects a malformed path at the contract boundary (400)', async () => {
      const { auth } = await authFor('sync-sign-3');
      const res = await app.request(
        filesSignEndpoint.path,
        json(auth, { op: 'put', paths: ['links/ok.enc', 'not-a-namespace/evil'] }),
        env,
      );
      expect(res.status).toBe(400);
    });
  });
});
