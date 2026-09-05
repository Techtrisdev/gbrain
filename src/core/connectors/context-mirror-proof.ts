import { createHash, createHmac } from 'node:crypto';

import { safeHexEqual } from '../timing-safe.ts';

const SHA256 = /^[a-f0-9]{64}$/;
const BUILD_SHA = /^[a-f0-9]{40}$/;
const MAX_PROOF_AGE_MS = 15 * 60_000;
const MAX_CLOCK_SKEW_MS = 60_000;
const PROOF_DOMAIN = 'context-mirror-proof/v1\n';
const VERIFIED_PROOF = Symbol('verified-context-mirror-proof');

export type ContextMirrorProofKind = 'runtime_inventory' | 'replay_ledger';

interface ContextMirrorProofArtifact {
  evidence_fingerprint: string;
  gbrain_build_sha: string;
  host_build_sha: string;
  observed_at: string;
  proof_kind: ContextMirrorProofKind;
  recovery_hold_generation: number;
  result: 'ok';
  schema_version: 1;
  source_id: string;
}

export interface VerifiedContextMirrorProof {
  readonly [VERIFIED_PROOF]: true;
  receiptFingerprint: string;
  evidenceFingerprint: string;
  observedAt: string;
}

export class ContextMirrorProofError extends Error {}

function canonicalArtifact(proof: ContextMirrorProofArtifact): string {
  return JSON.stringify({
    evidence_fingerprint: proof.evidence_fingerprint,
    gbrain_build_sha: proof.gbrain_build_sha,
    host_build_sha: proof.host_build_sha,
    observed_at: proof.observed_at,
    proof_kind: proof.proof_kind,
    recovery_hold_generation: proof.recovery_hold_generation,
    result: proof.result,
    schema_version: proof.schema_version,
    source_id: proof.source_id,
  });
}

function requiredBuildSha(name: string, value: string): string {
  if (!BUILD_SHA.test(value)) {
    throw new ContextMirrorProofError(`${name} is not an immutable full build SHA`);
  }
  return value;
}

export function verifyContextMirrorProofAttestation(input: {
  kind: ContextMirrorProofKind;
  sourceId: string;
  attestation: unknown;
  signature: unknown;
  secret: string | undefined;
  expectedGbrainBuildSha: string;
  expectedHostBuildSha: string;
  recoveryHoldGeneration: number;
  recoveryHeldAt: string | null;
  now?: Date;
}): VerifiedContextMirrorProof | null {
  const absent = input.attestation === undefined || input.attestation === null || input.attestation === '';
  const signatureAbsent = input.signature === undefined || input.signature === null || input.signature === '';
  if (absent && signatureAbsent) return null;
  if (absent || signatureAbsent) {
    throw new ContextMirrorProofError('proof artifact and signature must be supplied together');
  }
  if (typeof input.attestation !== 'string' || input.attestation.length > 4_096) {
    throw new ContextMirrorProofError('proof artifact must be bounded canonical JSON');
  }
  if (typeof input.signature !== 'string' || !SHA256.test(input.signature)) {
    throw new ContextMirrorProofError('proof signature must be a lowercase sha256 HMAC');
  }
  if (!input.secret || Buffer.byteLength(input.secret, 'utf8') < 32) {
    throw new ContextMirrorProofError('recovery proof verification is not configured');
  }
  const expectedSignature = createHmac('sha256', input.secret)
    .update(PROOF_DOMAIN, 'utf8')
    .update(input.attestation, 'utf8')
    .digest('hex');
  if (!safeHexEqual(input.signature, expectedSignature)) {
    throw new ContextMirrorProofError('proof signature does not match');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.attestation);
  } catch {
    throw new ContextMirrorProofError('proof artifact is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ContextMirrorProofError('proof artifact must be an object');
  }
  const proof = parsed as Record<string, unknown>;
  const keys = Object.keys(proof).sort();
  const expectedKeys = [
    'evidence_fingerprint', 'gbrain_build_sha', 'host_build_sha', 'observed_at',
    'proof_kind', 'recovery_hold_generation', 'result', 'schema_version', 'source_id',
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new ContextMirrorProofError('proof artifact fields do not match schema version 1');
  }
  if (
    proof.schema_version !== 1
    || proof.proof_kind !== input.kind
    || proof.source_id !== input.sourceId
    || proof.result !== 'ok'
    || proof.recovery_hold_generation !== input.recoveryHoldGeneration
  ) {
    throw new ContextMirrorProofError('proof artifact is not bound to this recovery hold');
  }
  if (typeof proof.evidence_fingerprint !== 'string' || !SHA256.test(proof.evidence_fingerprint)) {
    throw new ContextMirrorProofError('proof evidence fingerprint is invalid');
  }
  const expectedGbrainBuildSha = requiredBuildSha('current GBrain build', input.expectedGbrainBuildSha);
  const expectedHostBuildSha = requiredBuildSha('current host build', input.expectedHostBuildSha);
  if (proof.gbrain_build_sha !== expectedGbrainBuildSha || proof.host_build_sha !== expectedHostBuildSha) {
    throw new ContextMirrorProofError('proof artifact build identity is stale');
  }
  if (typeof proof.observed_at !== 'string' || !input.recoveryHeldAt) {
    throw new ContextMirrorProofError('proof artifact requires an active recovery hold timestamp');
  }
  const observedAt = new Date(proof.observed_at).getTime();
  const heldAt = new Date(input.recoveryHeldAt).getTime();
  const now = (input.now ?? new Date()).getTime();
  if (
    !Number.isFinite(observedAt)
    || !Number.isFinite(heldAt)
    || observedAt < heldAt
    || observedAt > now + MAX_CLOCK_SKEW_MS
    || now - observedAt > MAX_PROOF_AGE_MS
  ) {
    throw new ContextMirrorProofError('proof artifact is stale for this recovery hold');
  }
  const typedProof = proof as unknown as ContextMirrorProofArtifact;
  if (input.attestation !== canonicalArtifact(typedProof)) {
    throw new ContextMirrorProofError('proof artifact must use the canonical JSON encoding');
  }

  return {
    [VERIFIED_PROOF]: true,
    receiptFingerprint: createHash('sha256')
      .update(PROOF_DOMAIN, 'utf8')
      .update(input.attestation, 'utf8')
      .digest('hex'),
    evidenceFingerprint: proof.evidence_fingerprint,
    observedAt: proof.observed_at,
  };
}
