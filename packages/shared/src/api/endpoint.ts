import type { z } from 'zod';

// The shared API "contract" primitive. Each endpoint is described once here in
// `shared` (the lowest, platform-agnostic layer); bracemark-api reads it to validate
// requests + type responses, and every client (bracemark-web, bracemark-extension,
// future bracemark-expo) reads the same descriptor to build a typed fetch. Nobody
// imports bracemark-api — the dependency arrow only ever points down at `shared` —
// which is why we hand-write this instead of using Hono RPC (its types are
// derived from the app instance, forcing client → app coupling that the Nx
// `type:`/`platform:` boundaries forbid). See docs/architecture.md.

// URL version prefix for the API surface. The version is part of the wire
// contract, so it lives in the path string here (not in each client's baseUrl —
// `new URL('/v1/…', baseUrl)` would discard a path on baseUrl anyway) and every
// endpoint path is built from it. Long-lived clients we don't control the update
// cadence of (the extension, a future Expo app) can stay pinned to /v1 while the
// web app moves on. Bumping to v2 means adding `API_V2` and migrating paths;
// operational roots (`/`, `/health`) stay unversioned. See docs/api-contracts.md.
export const API_V1 = '/v1';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiEndpoint<
  TMethod extends HttpMethod = HttpMethod,
  TPath extends string = string,
  TRequest extends z.ZodType = z.ZodType,
  TResponse extends z.ZodType = z.ZodType,
> {
  method: TMethod;
  path: TPath;
  /** Validates the request: query params for GET/DELETE, JSON body otherwise. */
  request: TRequest;
  /** Validates (and types) the JSON response body. */
  response: TResponse;
}

// The uniform JSON error envelope every endpoint returns on a non-2xx response.
// Defined here in `shared` — part of the wire contract, like the endpoint
// descriptors themselves — so the worker apps (bracemark-api, bracemark-extractor) emit
// one shape and every client parses one shape across both origins. `error` is a
// stable, client-parseable code (e.g. 'unauthorized', 'rate_limited',
// 'http_error', 'internal_error'); `message` is optional and for humans/logs only.
export interface ErrorBody {
  error: string;
  message?: string;
}

// Identity helper that preserves the literal method/path and the schema types,
// while constraining the object to the `ApiEndpoint` shape. Prefer this over a
// bare `as const` object so a malformed descriptor fails at the definition site.
export function defineEndpoint<
  TMethod extends HttpMethod,
  TPath extends string,
  TRequest extends z.ZodType,
  TResponse extends z.ZodType,
>(
  endpoint: ApiEndpoint<TMethod, TPath, TRequest, TResponse>,
): ApiEndpoint<TMethod, TPath, TRequest, TResponse> {
  return endpoint;
}
