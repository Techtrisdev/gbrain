import pkg from '../package.json';
export const VERSION = pkg.version;

function buildShaFromEnv(env: Record<string, string | undefined>): string {
  const value = env.GBRAIN_BUILD_SHA ?? env.RAILWAY_GIT_COMMIT_SHA ?? env.GIT_COMMIT_SHA;
  return value && /^[0-9a-f]{40}$/i.test(value.trim()) ? value.trim().toLowerCase() : 'unknown';
}

/** Full source SHA when the deploy supplies it; never truncate or invent one. */
export const BUILD_SHA = buildShaFromEnv(process.env);
