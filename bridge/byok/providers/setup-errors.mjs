// What a failed key test in setup means (onboarding spec §3.4.4, §9.3; plan §3.4): the one
// tiny test request in Connect <AI> fails for reasons play never meets (a key with no workspace, a
// key that can't reach the default model, an organization OpenAI wants verified), and each gets
// its own result with its own fix. These rules apply to that one test only (C-24): classify()'s
// order for play (code, type, status; PRD §10) and errors.mjs's kinds and in-game lines are
// unchanged. The fixtures behind each rule are the providers' docs; they stay UNVERIFIED until the
// owner-gated live tests (spec §12, R5–R8).
//
//   setupKind(err, manifestId) → { error, documented, inferred, tier, resetAt? }
//
// error: the setup result's id (the renderer's KEY_FIX table; strings connectResult.*):
//   auth_invalid, out_of_credit, spend_limit, workspace_required, model_access, key_restricted,
//   org_verification, region_blocked, rate_limited, overloaded, network, restart, keystore_error, failed.
// restart: the app's own egress guard refused the AI's own host (every request setup's test makes
//   goes there): the guard had stopped, or lost the host. That's never the player's internet, so
//   it's never network's "Check your internet"; a restart is the fix (fix-102, 2026-09-30).
// documented: an out_of_credit the company documents as "no credit" (the first key is saved
//   anyway, T1); inferred: a guess from the status alone (xAI, Google), so the key is only held.
// tier: a spend_limit that is the account's monthly tier cap (Anthropic), not a limit the player set.
import { extractError } from './errors.mjs';

const lower = v => String(v ?? '').toLowerCase();

/** The provider's own message and code, from the error's body (in memory only; never logged). */
function detailsOf(err) {
  let x = {};
  try { x = extractError(err?.body) ?? {}; } catch { x = {}; }
  const meta = x.metadata && typeof x.metadata === 'object' ? x.metadata : {};
  return { message: lower(x.message), type: lower(x.type ?? err?.type), code: lower(err?.code ?? x.code), limitSource: lower(meta.limit_source) };
}

/** play's kind → the setup result, when no provider rule matched. */
const BY_KIND = {
  auth_invalid: 'auth_invalid', oauth_expired: 'auth_invalid',
  out_of_credit: 'out_of_credit', spend_limit: 'spend_limit',
  rate_limited: 'rate_limited', rate_limited_daily: 'rate_limited',
  overloaded: 'overloaded', timeout: 'overloaded', interrupted: 'overloaded',
  network_before_send: 'network', network_after_send: 'network', tls: 'network', egress_blocked: 'restart',
  region_blocked: 'region_blocked', model_not_found: 'model_access',
};

export function setupKind(err, manifestId) {
  const kind = typeof err?.kind === 'string' ? err.kind : 'unknown';
  const status = Number(err?.status) || null;
  const d = detailsOf(err);
  const out = (error, extra = {}) => ({ error, documented: false, inferred: false, tier: false, ...extra });

  if (kind === 'no_key') return out(err?.code === 'keystore_error' ? 'keystore_error' : 'failed');

  if (manifestId === 'anthropic') {
    if (status === 400 && d.message.includes('anthropic-workspace-id')) return out('workspace_required');
    if (status === 403 && d.type === 'forbidden') return out('region_blocked');
    if (status === 403 && d.type === 'permission_error') return out('model_access');
    if (status === 404) return out('model_access');
    if (kind === 'spend_limit' && d.code === 'enforced_spend_limit_reached') {
      return out('spend_limit', { tier: true, ...(Number.isFinite(err?.resetAt) ? { resetAt: err.resetAt } : {}) });
    }
    if (kind === 'out_of_credit') return out('out_of_credit', { documented: status === 402 || d.message.includes('credit balance is too low') });
  }

  if (manifestId === 'openai') {
    if (status === 401 && d.message.includes('missing scopes')) return out('key_restricted');
    if (status === 400 && d.message.includes('must be verified')) return out('org_verification');
    if (status === 404 || d.code === 'model_not_found') return out('model_access');
    if (d.code === 'insufficient_quota' || d.code === 'credit_balance_exhausted') return out('out_of_credit', { documented: true });
  }

  if (manifestId === 'xai') {
    // xAI answers a bad key with a 400 at the key check or the test [KF-35].
    if (status === 400) return out('auth_invalid');
    // One request can't reach Tier 0's rate limit, so a 429 or 402 on the one test is no credit,
    // inferred from the status: the key is held, never saved as no_credit [KF-33, KF-36].
    if (status === 429 || status === 402) return out('out_of_credit', { inferred: true });
  }

  if (manifestId === 'google') {
    // A key whose project can't use the Gemini API (403 PERMISSION_DENIED) is a good key without access.
    if (status === 403 || status === 404) return out('model_access');
    // One request can't reach a rate limit: a 429 on the one test is a model the key's tier has no
    // quota for (limit 0 until billing is set up), inferred from the status, so the key is only held.
    if (status === 429) return out('out_of_credit', { inferred: true });
  }

  return out(BY_KIND[kind] ?? 'failed');
}
