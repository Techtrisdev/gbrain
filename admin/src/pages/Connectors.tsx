import React, { useState, useEffect } from 'react';
import { api } from '../api';

/** A connector row as returned by GET /admin/api/connectors. Secrets are never present —
 *  only `hasSecret` (boolean) and the token's status/account/expiry. */
interface Connector {
  sourceId: string;
  sourceName: string;
  provider: string;
  enabled: boolean;
  account: string | null;
  hasSecret: boolean;
  token: { status: string; account: string | null; expiresAt: string | null } | null;
  selection: unknown;
  policy: unknown;
}

export function ConnectorsPage() {
  const [rows, setRows] = useState<Connector[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-row JSON draft for the selection + policy editors, keyed by `${sourceId}|${provider}`.
  const [draft, setDraft] = useState<Record<string, { selection: string; policy: string }>>({});

  useEffect(() => { load(); }, []);

  const keyOf = (c: Connector) => `${c.sourceId}|${c.provider}`;

  const load = () => {
    api.connectors().then((r: Connector[]) => {
      setRows(r);
      const d: Record<string, { selection: string; policy: string }> = {};
      for (const c of r) {
        d[`${c.sourceId}|${c.provider}`] = {
          selection: c.selection ? JSON.stringify(c.selection, null, 2) : '',
          policy: c.policy ? JSON.stringify(c.policy, null, 2) : '',
        };
      }
      setDraft(d);
    }).catch((e) => setError(String(e?.message ?? e)));
  };

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const toggleEnabled = (c: Connector) =>
    run(keyOf(c), () => api.connectorConfig(c.provider, c.sourceId, { enabled: !c.enabled }));

  const disconnect = (c: Connector) => {
    if (!confirm(`Disconnect ${c.provider} from ${c.sourceName}? This clears the stored token.`)) return;
    run(keyOf(c), () => api.connectorDisconnect(c.provider, c.sourceId));
  };

  const connect = (c: Connector) =>
    run(keyOf(c), async () => {
      const { authorizeUrl } = await api.connectorConnect(c.provider, c.sourceId);
      if (authorizeUrl) window.open(authorizeUrl, '_blank', 'noopener');
    });

  const saveConfig = (c: Connector) => {
    const d = draft[keyOf(c)] ?? { selection: '', policy: '' };
    let selection: unknown;
    let policy: unknown;
    try {
      selection = d.selection.trim() ? JSON.parse(d.selection) : undefined;
      policy = d.policy.trim() ? JSON.parse(d.policy) : undefined;
    } catch {
      setError('Selection / policy must be valid JSON.');
      return;
    }
    const patch: { selection?: unknown; policy?: unknown } = {};
    if (selection !== undefined) patch.selection = selection;
    if (policy !== undefined) patch.policy = policy;
    if (Object.keys(patch).length === 0) { setError('Nothing to save.'); return; }
    run(keyOf(c), () => api.connectorConfig(c.provider, c.sourceId, patch));
  };

  const tokenBadge = (c: Connector) => {
    if (!c.token) return <span className="badge" style={{ color: 'var(--text-muted)' }}>no token</span>;
    const ok = c.token.status === 'active';
    return (
      <span className="badge" style={{ color: ok ? 'var(--success, #5ad17e)' : 'var(--error, #ff6b6b)' }}>
        {c.token.status}
      </span>
    );
  };

  return (
    <>
      <h1 className="page-title">Connectors</h1>

      {error && (
        <div data-testid="connectors-error" style={{ color: 'var(--error, #ff6b6b)', marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <div data-testid="connectors-empty" style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
          No connectors configured. Add one with <span className="mono">gbrain sources connector set</span>.
        </div>
      ) : (
        <table data-testid="connectors-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Provider</th>
              <th>Enabled</th>
              <th>Account</th>
              <th>Token</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const key = keyOf(c);
              return (
                <React.Fragment key={key}>
                  <tr data-testid={`connector-row-${key}`}>
                    <td>{c.sourceName}</td>
                    <td className="mono">{c.provider}</td>
                    <td>
                      <span className={`badge ${c.enabled ? 'badge-success' : ''}`} style={{ color: c.enabled ? 'var(--success, #5ad17e)' : 'var(--text-muted)' }}>
                        {c.enabled ? 'enabled' : 'disabled'}
                      </span>
                    </td>
                    <td className="mono">{c.account ?? '—'}</td>
                    <td>{tokenBadge(c)}</td>
                    <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button data-testid={`toggle-${key}`} disabled={busy === key} onClick={() => toggleEnabled(c)}
                        style={btn()}>{c.enabled ? 'Disable' : 'Enable'}</button>
                      <button data-testid={`connect-${key}`} disabled={busy === key} onClick={() => connect(c)}
                        style={btn()}>{c.token ? 'Reconnect' : 'Connect'}</button>
                      <button data-testid={`disconnect-${key}`} disabled={busy === key || !c.token} onClick={() => disconnect(c)}
                        style={btn('var(--error, #ff6b6b)')}>Disconnect</button>
                      <button data-testid={`config-${key}`} onClick={() => setExpanded(expanded === key ? null : key)}
                        style={btn()}>Config</button>
                    </td>
                  </tr>
                  {expanded === key && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--bg-secondary, #0f0f1a)', padding: 16 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                          <div>
                            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                              Selection (channels / labels / calendars) — JSON
                            </div>
                            <textarea
                              data-testid={`selection-${key}`}
                              value={draft[key]?.selection ?? ''}
                              onChange={(e) => setDraft({ ...draft, [key]: { ...draft[key], selection: e.target.value } })}
                              rows={6}
                              style={editorStyle()}
                            />
                          </div>
                          <div>
                            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                              Retention / redaction policy — JSON
                            </div>
                            <textarea
                              data-testid={`policy-${key}`}
                              value={draft[key]?.policy ?? ''}
                              onChange={(e) => setDraft({ ...draft, [key]: { ...draft[key], policy: e.target.value } })}
                              rows={6}
                              style={editorStyle()}
                            />
                          </div>
                        </div>
                        <div style={{ marginTop: 12 }}>
                          <button data-testid={`save-config-${key}`} disabled={busy === key} onClick={() => saveConfig(c)}
                            style={btn('var(--text-primary)')}>Save config</button>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function btn(color = 'var(--text-secondary)'): React.CSSProperties {
  return {
    background: 'transparent', border: '1px solid var(--border)', color,
    padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
  };
}
function editorStyle(): React.CSSProperties {
  return {
    width: '100%', background: 'var(--bg-primary, #0a0a14)', color: 'var(--text-primary)',
    border: '1px solid var(--border)', borderRadius: 6, padding: 8, fontSize: 12,
    fontFamily: 'var(--font-mono, monospace)', resize: 'vertical',
  };
}
