import pkg from '../package.json';
export const VERSION = pkg.version;

function fullSha(value: string | undefined): string | null {
  return value && /^[0-9a-f]{40}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

export function gbrainBuildShaFromEnv(env: Record<string, string | undefined>): string {
  const explicit = fullSha(env.GBRAIN_BUILD_SHA);
  if (explicit) return explicit;

  // A host repository can install GBrain from an immutable GitHub package pin.
  // Railway's own git SHA describes that host repository, not this package, so
  // it must never be substituted for the engine identity.
  const packageRef = env.GBRAIN_PACKAGE?.trim() ?? '';
  const pinned = fullSha(packageRef.match(/#([0-9a-f]{40})$/i)?.[1]);
  return pinned ?? 'unknown';
}

export function hostBuildShaFromEnv(env: Record<string, string | undefined>): string {
  return fullSha(env.GBRAIN_HOST_BUILD_SHA)
    ?? fullSha(env.RAILWAY_GIT_COMMIT_SHA)
    ?? 'unknown';
}

/** Full engine source SHA from an explicit value or immutable package pin. */
export const BUILD_SHA = gbrainBuildShaFromEnv(process.env);

/** Full SHA of the repository/container that packaged the engine. */
export const HOST_BUILD_SHA = hostBuildShaFromEnv(process.env);
