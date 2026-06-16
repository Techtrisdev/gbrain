import React, { useState, useEffect } from 'react';
import { api } from '../api';

/** A candidate row as returned by GET /admin/api/candidates (listCandidates). */
interface Candidate {
  id: number;
  source_id: string;
  source_name: string | null;
  provider: string | null;
  source_record_id: string;
  proposed_slug: string | null;
  proposed_markdown: string | null;
  confidence: number | null;
  redactions: unknown[];
  rationale_ref: string | null;
  status: 'pending' | 'accepted' | 'rejected';
  status_reason: string | null;
  acted_by: string | null;
  acted_at: string | null;
  needs_rationale: boolean;
  proposed_at: string;
}

type Status = 'pending' | 'accepted' | 'rejected';

export function ReviewQueuePage() {
  const [status, setStatus] = useState<Status>('pending');
  const [data, setData] = useState<{ rows: Candidate[]; total: number; page: number; pages: number }>({
    rows: [], total: 0, page: 1, pages: 1,
  });
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // TECH-2109: reviewer-selected promotion target for the expanded candidate.
  // Default mode 'inbox' (a new inbox page; the Brain defaults the path). 'existing_page'
  // promotes onto an existing content page at targetPath.
  const [targetKind, setTargetKind] = useState<'inbox' | 'existing_page'>('inbox');
  const [targetPath, setTargetPath] = useState('');

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [status, page]);

  const load = () => {
    api.candidates(status, page).then(setData).catch((e) => setError(String(e?.message ?? e)));
  };

  const toggle = (id: number) => {
    setExpanded(expanded === id ? null : id);
    setReason('');
    setError(null);
    // Reset the promotion target to the default (new inbox page) on each expand.
    setTargetKind('inbox');
    setTargetPath('');
  };

  const act = async (id: number, kind: 'approve' | 'reject') => {
    setBusy(id);
    setError(null);
    try {
      if (kind === 'approve') {
        await api.candidateApprove(id, {
          target_kind: targetKind,
          target_path: targetKind === 'existing_page' ? targetPath.trim() : undefined,
        });
      } else {
        await api.candidateReject(id, reason);
      }
      setExpanded(null);
      setReason('');
      setTargetKind('inbox');
      setTargetPath('');
      load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const timeAgo = (ts: string) => {
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(ts).toLocaleDateString();
  };

  const preview = (md: string | null) => {
    if (!md) return '—';
    const firstLine = md.split('\n').find((l) => l.trim()) ?? '';
    return firstLine.length > 90 ? firstLine.slice(0, 90) + '…' : firstLine;
  };

  const tab = (s: Status, label: string) => (
    <a
      data-testid={`tab-${s}`}
      className={`nav-item ${status === s ? 'active' : ''}`}
      onClick={() => { setStatus(s); setPage(1); setExpanded(null); }}
      style={{
        padding: '6px 12px', cursor: 'pointer', borderRadius: 6, fontSize: 13,
        background: status === s ? 'var(--bg-secondary)' : 'transparent',
        color: status === s ? 'var(--text-primary)' : 'var(--text-secondary)',
      }}
    >
      {label}
    </a>
  );

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>Review Queue</h1>
        <div style={{ display: 'flex', gap: 4 }}>
          {tab('pending', 'Pending')}
          {tab('accepted', 'Accepted')}
          {tab('rejected', 'Rejected')}
        </div>
      </div>

      {error && (
        <div data-testid="review-error" style={{ color: 'var(--error, #ff6b6b)', marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {data.rows.length === 0 ? (
        <div data-testid="review-empty" style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
          No {status} candidates.
        </div>
      ) : (
        <>
          <table data-testid="review-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Provider</th>
                <th>Candidate</th>
                <th>Confidence</th>
                <th>Flags</th>
                <th>Proposed</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((c) => (
                <React.Fragment key={c.id}>
                  <tr data-testid={`candidate-row-${c.id}`} onClick={() => toggle(c.id)} style={{ cursor: 'pointer' }}>
                    <td>{c.source_name ?? c.source_id}</td>
                    <td className="mono">{c.provider ?? '—'}</td>
                    <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {preview(c.proposed_markdown)}
                    </td>
                    <td className="mono">{c.confidence != null ? c.confidence.toFixed(2) : '—'}</td>
                    <td>
                      {c.needs_rationale && (
                        <span
                          data-testid={`flag-needs-rationale-${c.id}`}
                          className="badge"
                          title="High-confidence candidate with no linked rationale take — review before promoting."
                          style={{ background: 'var(--warning-bg, #4a3a10)', color: 'var(--warning, #f5c451)' }}
                        >
                          needs rationale
                        </span>
                      )}
                    </td>
                    <td style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{timeAgo(c.proposed_at)}</td>
                  </tr>
                  {expanded === c.id && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--bg-secondary, #0f0f1a)', padding: 16 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '6px 12px', fontSize: 13 }}>
                          <span style={{ color: 'var(--text-muted)' }}>Slug</span>
                          <span className="mono">{c.proposed_slug ?? '—'}</span>
                          <span style={{ color: 'var(--text-muted)' }}>Record</span>
                          <span className="mono">{c.source_record_id}</span>
                          <span style={{ color: 'var(--text-muted)' }}>Rationale</span>
                          <span className="mono">{c.rationale_ref ?? '(none linked)'}</span>
                          <span style={{ color: 'var(--text-muted)' }}>Proposed markdown</span>
                          <pre
                            data-testid={`candidate-markdown-${c.id}`}
                            className="mono"
                            style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 300, overflow: 'auto' }}
                          >
                            {c.proposed_markdown ?? '(empty)'}
                          </pre>
                          {Array.isArray(c.redactions) && c.redactions.length > 0 && (
                            <>
                              <span style={{ color: 'var(--text-muted)' }}>Redactions</span>
                              <span className="mono" style={{ fontSize: 12 }}>{JSON.stringify(c.redactions)}</span>
                            </>
                          )}
                          {c.status !== 'pending' && (
                            <>
                              <span style={{ color: 'var(--text-muted)' }}>Decision</span>
                              <span>
                                <span className={`badge badge-${c.status}`}>{c.status}</span>
                                {c.acted_by ? ` by ${c.acted_by}` : ''}
                                {c.acted_at ? ` · ${new Date(c.acted_at).toLocaleString()}` : ''}
                              </span>
                              {c.status_reason && (
                                <>
                                  <span style={{ color: 'var(--text-muted)' }}>Reason</span>
                                  <span>{c.status_reason}</span>
                                </>
                              )}
                            </>
                          )}
                        </div>

                        {c.status === 'pending' && (
                          <>
                          <div
                            data-testid={`promotion-target-${c.id}`}
                            style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Promote to</span>
                            <select
                              data-testid={`target-kind-${c.id}`}
                              value={targetKind}
                              onChange={(e) => setTargetKind(e.target.value as 'inbox' | 'existing_page')}
                              style={{
                                background: 'var(--bg-primary, #0a0a14)', color: 'var(--text-primary)',
                                border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 13,
                              }}
                            >
                              <option value="inbox">New inbox page (default)</option>
                              <option value="existing_page">Existing page…</option>
                            </select>
                            {targetKind === 'existing_page' && (
                              <input
                                data-testid={`target-path-${c.id}`}
                                value={targetPath}
                                onChange={(e) => setTargetPath(e.target.value)}
                                placeholder="content path, e.g. companies/acme.md"
                                style={{
                                  flex: 1, minWidth: 220, background: 'var(--bg-primary, #0a0a14)',
                                  color: 'var(--text-primary)', border: '1px solid var(--border)',
                                  borderRadius: 6, padding: '6px 10px', fontSize: 13,
                                }}
                              />
                            )}
                          </div>
                          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                            <input
                              data-testid={`reject-reason-${c.id}`}
                              value={reason}
                              onChange={(e) => setReason(e.target.value)}
                              placeholder="Reason (required to reject)"
                              onClick={(e) => e.stopPropagation()}
                              style={{
                                flex: 1, background: 'var(--bg-primary, #0a0a14)', color: 'var(--text-primary)',
                                border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 13,
                              }}
                            />
                            <button
                              data-testid={`approve-${c.id}`}
                              disabled={busy === c.id || (targetKind === 'existing_page' && !targetPath.trim())}
                              onClick={(e) => { e.stopPropagation(); act(c.id, 'approve'); }}
                              style={{
                                background: 'var(--success-bg, #103a1f)', color: 'var(--success, #5ad17e)',
                                border: '1px solid var(--success, #5ad17e)', borderRadius: 6, padding: '6px 14px',
                                fontSize: 13,
                                cursor: targetKind === 'existing_page' && !targetPath.trim() ? 'not-allowed' : 'pointer',
                                opacity: targetKind === 'existing_page' && !targetPath.trim() ? 0.5 : 1,
                              }}
                            >
                              Approve
                            </button>
                            <button
                              data-testid={`reject-${c.id}`}
                              disabled={busy === c.id || !reason.trim()}
                              onClick={(e) => { e.stopPropagation(); act(c.id, 'reject'); }}
                              style={{
                                background: 'transparent', color: 'var(--error, #ff6b6b)',
                                border: '1px solid var(--error, #ff6b6b)', borderRadius: 6, padding: '6px 14px',
                                fontSize: 13, cursor: reason.trim() ? 'pointer' : 'not-allowed', opacity: reason.trim() ? 1 : 0.5,
                              }}
                            >
                              Reject
                            </button>
                          </div>
                          </>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>

          <div className="pagination">
            <span>Page {data.page} of {data.pages} ({data.total} total)</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button disabled={data.page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
              <button disabled={data.page >= data.pages} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
