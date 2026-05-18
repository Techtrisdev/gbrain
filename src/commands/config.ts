import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';

function redactUrl(url: string): string {
  // Redact password in postgresql:// URLs
  return url.replace(
    /(postgresql:\/\/[^:]+:)([^@]+)(@)/,
    '$1***$3',
  );
}

// v0.36.x #892: sensitive config-key allowlist. The `show` path used a
// loose `.includes('key')` check that also redacts (works); the `set` path
// previously printed the raw value to stderr, leaking API keys via shell
// history + scrollback. This helper is the single source of truth so the
// two surfaces can't drift again. Match on word-segments to avoid
// false-positives (e.g. `monkey` doesn't match `key`).
export function isSensitiveConfigKey(key: string): boolean {
  const lower = key.toLowerCase();
  // Word-boundary matches: foo_key, foo.key, key_foo, key, api_key, ...
  return /(^|[._-])(key|secret|token|password|pwd|passwd|auth)([._-]|$)/.test(lower);
}

export function redactConfigValue(key: string, value: string): string {
  if (value.includes('postgresql://')) return redactUrl(value);
  if (isSensitiveConfigKey(key)) return '***';
  return value;
}

export async function runConfig(engine: BrainEngine, args: string[]) {
  const action = args[0];

  if (action === 'show') {
    const config = loadConfig();
    if (!config) {
      console.error('No config found. Run: gbrain init');
      process.exit(1);
    }
    console.log('GBrain config:');
    for (const [k, v] of Object.entries(config)) {
      const display = typeof v === 'string' ? redactConfigValue(k, v) : v;
      console.log(`  ${k}: ${display}`);
    }
    return;
  }

  // v0.32.3 [CDX-7+8]: `unset` is required before `gbrain search modes
  // --reset` can implement its contract. Two shapes:
  //   gbrain config unset <key>             — single-key delete
  //   gbrain config unset --pattern <pfx>   — prefix-bulk delete
  if (action === 'unset') {
    const flagIdx = args.indexOf('--pattern');
    if (flagIdx !== -1) {
      const prefix = args[flagIdx + 1];
      if (!prefix || prefix.length === 0) {
        console.error('Usage: gbrain config unset --pattern <prefix>');
        process.exit(1);
      }
      const keys = await engine.listConfigKeys(prefix);
      if (keys.length === 0) {
        console.log(`No keys match prefix "${prefix}".`);
        return;
      }
      let deleted = 0;
      for (const k of keys) {
        const n = await engine.unsetConfig(k);
        if (n > 0) deleted += n;
      }
      console.log(`Unset ${deleted} key(s) matching "${prefix}":`);
      for (const k of keys) console.log(`  - ${k}`);
      return;
    }

    const key = args[1];
    if (!key) {
      console.error('Usage: gbrain config unset <key> | --pattern <prefix>');
      process.exit(1);
    }
    const n = await engine.unsetConfig(key);
    if (n > 0) {
      console.log(`Unset ${key}`);
    } else {
      console.error(`Config key not found: ${key}`);
      process.exit(1);
    }
    return;
  }

  const key = args[1];
  const value = args[2];

  if (action === 'get' && key) {
    const val = await engine.getConfig(key);
    if (val !== null) {
      console.log(val);
    } else {
      console.error(`Config key not found: ${key}`);
      process.exit(1);
    }
  } else if (action === 'set' && key && value) {
    await engine.setConfig(key, value);
    // v0.36.x #892: redact sensitive values in confirmation output. API
    // keys / tokens / passwords are commonly set from terminals with
    // scrollback; echoing the raw value to stderr leaks the secret.
    console.log(`Set ${key} = ${redactConfigValue(key, value)}`);
  } else {
    console.error('Usage: gbrain config [show|get|set|unset] <key> [value]');
    console.error('       gbrain config unset --pattern <prefix>');
    process.exit(1);
  }
}
