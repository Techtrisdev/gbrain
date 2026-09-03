import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import {
  configureTrustedProxy,
  createOAuthTokenRateLimiters,
  resolveOAuthTokenClientIp,
} from '../src/commands/serve-http.ts';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function startServer(options: { clientMax: number; ipMax: number }) {
  const app = express();
  configureTrustedProxy(app);
  const limiters = createOAuthTokenRateLimiters({
    windowMs: 60_000,
    clientMax: options.clientMax,
    ipMax: options.ipMax,
  });
  app.post(
    '/token',
    express.urlencoded({ extended: false }),
    limiters.client,
    limiters.ip,
    (_req, res) => res.status(204).end(),
  );
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  return `http://127.0.0.1:${address.port}`;
}

async function mint(base: string, clientId: string, forwardedIp: string) {
  return fetch(`${base}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Real-IP': forwardedIp,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId }),
  });
}

async function exchangeOtherGrant(base: string, forwardedIp: string) {
  return fetch(`${base}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Real-IP': forwardedIp,
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: 'test-code' }),
  });
}

describe('OAuth token rate limiting', () => {
  test('one noisy OAuth client cannot exhaust another client budget', async () => {
    const base = await startServer({ clientMax: 2, ipMax: 4 });

    expect((await mint(base, 'client-a', '198.51.100.10')).status).toBe(204);
    expect((await mint(base, 'client-a', '198.51.100.10')).status).toBe(204);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await mint(base, 'client-a', '198.51.100.10')).status).toBe(429);
    }
    expect((await mint(base, 'client-b', '198.51.100.10')).status).toBe(204);
  });

  test('a caller on another address cannot consume the legitimate client budget', async () => {
    const base = await startServer({ clientMax: 1, ipMax: 10 });

    expect((await mint(base, 'client-a', '198.51.100.11')).status).toBe(204);
    expect((await mint(base, 'client-a', '198.51.100.11')).status).toBe(429);
    expect((await mint(base, 'client-a', '198.51.100.12')).status).toBe(204);
  });

  test('IP budget still blocks callers that rotate client identifiers', async () => {
    const base = await startServer({ clientMax: 10, ipMax: 2 });

    expect((await mint(base, 'client-a', '198.51.100.20')).status).toBe(204);
    expect((await mint(base, 'client-b', '198.51.100.20')).status).toBe(204);
    expect((await mint(base, 'client-c', '198.51.100.20')).status).toBe(429);
  });

  test('Railway real-client addresses receive independent IP budgets', async () => {
    const base = await startServer({ clientMax: 10, ipMax: 1 });

    expect((await mint(base, 'client-a', '198.51.100.30')).status).toBe(204);
    expect((await mint(base, 'client-b', '198.51.100.31')).status).toBe(204);
  });

  test('other OAuth grants do not consume the client-credentials budget', async () => {
    const base = await startServer({ clientMax: 1, ipMax: 10 });

    expect((await exchangeOtherGrant(base, '198.51.100.40')).status).toBe(204);
    expect((await exchangeOtherGrant(base, '198.51.100.40')).status).toBe(204);
    expect((await mint(base, 'client-a', '198.51.100.40')).status).toBe(204);
    expect((await mint(base, 'client-a', '198.51.100.40')).status).toBe(429);
  });

  test('an untrusted direct peer cannot choose its IP budget with X-Real-IP', () => {
    const request = {
      get: (name: string) => name.toLowerCase() === 'x-real-ip' ? '198.51.100.99' : undefined,
      socket: { remoteAddress: '203.0.113.10' },
    } as unknown as express.Request;

    expect(resolveOAuthTokenClientIp(request)).toBe('203.0.113.10');
  });
});
