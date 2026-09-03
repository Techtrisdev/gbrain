import { describe, expect, test } from 'bun:test';
import { gbrainBuildShaFromEnv, hostBuildShaFromEnv } from '../src/version.ts';

const GBRAIN_SHA = '1111111111111111111111111111111111111111';
const HOST_SHA = '2222222222222222222222222222222222222222';

describe('runtime build identity', () => {
  test('prefers an explicit full GBrain SHA', () => {
    expect(gbrainBuildShaFromEnv({
      GBRAIN_BUILD_SHA: GBRAIN_SHA.toUpperCase(),
      GBRAIN_PACKAGE: `github:example/gbrain#${HOST_SHA}`,
    })).toBe(GBRAIN_SHA);
  });

  test('derives GBrain identity from the immutable package pin', () => {
    expect(gbrainBuildShaFromEnv({
      GBRAIN_PACKAGE: `github:Techtrisdev/gbrain#${GBRAIN_SHA}`,
      RAILWAY_GIT_COMMIT_SHA: HOST_SHA,
    })).toBe(GBRAIN_SHA);
  });

  test('never mistakes the Railway host SHA for GBrain identity', () => {
    expect(gbrainBuildShaFromEnv({ RAILWAY_GIT_COMMIT_SHA: HOST_SHA })).toBe('unknown');
  });

  test('reports the full host repository SHA separately', () => {
    expect(hostBuildShaFromEnv({ RAILWAY_GIT_COMMIT_SHA: HOST_SHA })).toBe(HOST_SHA);
    expect(hostBuildShaFromEnv({ RAILWAY_GIT_COMMIT_SHA: '2222222' })).toBe('unknown');
  });
});
