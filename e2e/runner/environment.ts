export type E2EEnvironment = 'local' | 'staging';

export const STAGING_ORIGINS = {
  web: 'https://app.dryrunbase.com',
  api: 'https://api.dryrunbase.com',
  extractor: 'https://extractor.dryrunbase.com',
  site: 'https://dryrunbase.com',
} as const;

const LOCAL_ORIGINS = {
  web: 'http://localhost:3000',
  api: 'http://localhost:8787',
  extractor: 'http://localhost:8788',
  site: 'http://localhost:3001',
};

export function resolveEnvironment(env: NodeJS.ProcessEnv = process.env): {
  environment: E2EEnvironment;
  origins: typeof LOCAL_ORIGINS;
} {
  const environment = env.E2E_ENVIRONMENT ?? 'local';
  if (environment !== 'local' && environment !== 'staging') {
    throw new Error('E2E_ENVIRONMENT must be local or staging; production is not an E2E target');
  }
  const defaults = environment === 'staging' ? STAGING_ORIGINS : LOCAL_ORIGINS;
  const origins = { ...defaults };
  for (const key of ['web', 'api', 'extractor', 'site'] as const) {
    const variable = `E2E_${key.toUpperCase()}_URL`;
    const url = new URL(env[variable] ?? defaults[key]);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`${variable} must be an origin without credentials, path, query or fragment`);
    }
    if (environment === 'staging' && url.origin !== STAGING_ORIGINS[key]) {
      throw new Error(`${variable} must be ${STAGING_ORIGINS[key]} in staging mode`);
    }
    if (
      environment === 'local' &&
      (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        !['http:', 'https:'].includes(url.protocol))
    ) {
      throw new Error(
        `${variable} must use loopback in local mode; use the staging targets instead`,
      );
    }
    origins[key] = url.origin;
  }
  return { environment, origins };
}

export const { environment: E2E_ENVIRONMENT, origins: E2E_ORIGINS } = resolveEnvironment();
export const IS_STAGING = E2E_ENVIRONMENT === 'staging';

export function requireLocalEnvironment(operation: string): void {
  if (IS_STAGING) throw new Error(`${operation} requires the local E2E environment`);
}
