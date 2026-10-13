import {
  checkUsernameEndpoint,
  readPasswordDoorEndpoint,
  readRecoveryDoorEndpoint,
} from '../auth/endpoints';
import { fetchImageEndpoint } from '../extract/endpoints';
import * as shared from '../index';
import type { ApiEndpoint } from './endpoint';

// A GET's input is sent as a query string (api/client.ts), and a query string is
// part of the request line — which bracemark-api's request log stores whole,
// beside the caller's IP. A body is in no log. So "which endpoints are GETs, and
// what do they put in the URL" is not a style question: it is the list of
// arguments that get written down off the device, and /privacy describes that
// list in a sentence nothing else connects to this package
// (docs/api-contracts.md, _a GET's query string reaches the request log_).
//
// Three lookups used to be on it with a username — check-username and the two
// door reads — and that is how an account name came to sit in a stored log
// entry. They are POSTs now. This spec is what stops the next one: a new GET, or
// a new field on an existing one, fails here until it is added below, and adding
// it is the moment to ask whether a person chose that value. If they did, make
// the endpoint a POST instead; only if it truly must be a GET does the page
// change in the same commit.
const QUERY_METHODS = new Set(['GET', 'DELETE']);

// Every value that may ride in a URL, by endpoint. Opaque ids, cursors and
// limits — things the server already stores or that say nothing about anyone.
const INVENTORY: Record<string, readonly string[]> = {
  'GET /v1/auth/session': [],
  'GET /v1/iap/status': [],
  'GET /v1/iap/prices': [],
  'GET /v1/ops/list': ['since', 'sincePath', 'limit'],
  'GET /v1/files/list': ['pageToken', 'limit'],
};

function isEndpoint(value: unknown): value is ApiEndpoint {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.method === 'string' &&
    typeof v.path === 'string' &&
    typeof v.request === 'object' &&
    typeof v.response === 'object'
  );
}

function queryKeys(endpoint: ApiEndpoint): string[] {
  const shape = (endpoint.request as { shape?: Record<string, unknown> }).shape;
  if (!shape) throw new Error(`${endpoint.method} ${endpoint.path}: request is not a plain object`);
  return Object.keys(shape);
}

describe('what a GET puts in the URL', () => {
  const endpoints: ApiEndpoint[] = (Object.values(shared) as unknown[]).filter(isEndpoint);
  const queried = endpoints.filter((e) => QUERY_METHODS.has(e.method));

  it('is exactly the inventory — a new GET, or a new field on one, is a decision', () => {
    const actual = Object.fromEntries(queried.map((e) => [`${e.method} ${e.path}`, queryKeys(e)]));

    expect(actual).toEqual(INVENTORY);
  });

  // Positive control for the filter above: the barrel really does yield the
  // endpoints, POSTs included, so an empty `queried` cannot pass by accident.
  it('keeps the username lookups out of it', () => {
    const lookups = [checkUsernameEndpoint, readPasswordDoorEndpoint, readRecoveryDoorEndpoint];

    for (const endpoint of lookups) {
      expect(endpoints).toContain(endpoint);
      expect(queryKeys(endpoint)).toEqual(['username']);
      expect(QUERY_METHODS.has(endpoint.method)).toBe(false);
    }
  });

  // The one entry this inventory used to tolerate: bracemark-extractor's image
  // proxy was `GET /v1/image?url=…`, an address someone saved in a query string,
  // excused by that Worker's request log being off. It is a POST now, so the list
  // above has no exception left to reason from.
  it('keeps the image proxy’s address out of it', () => {
    expect(endpoints).toContain(fetchImageEndpoint);
    expect(queryKeys(fetchImageEndpoint)).toEqual(['url']);
    expect(QUERY_METHODS.has(fetchImageEndpoint.method)).toBe(false);
  });
});
