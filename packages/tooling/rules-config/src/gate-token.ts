import { createHmac } from 'crypto';
import { injectable, bindingScopeValues } from 'inversify';

// The hidden PR-body marker that carries the gate token. An HTML comment so it does NOT render in the
// PR description a human reads, but survives round-tripping through `gh pr view --json body`. Versioned
// so the format can evolve without silently validating an old shape.
const MARKER_RE = /<!--\s*webpieces-pr-gate\s+v1\s+token=([0-9a-f]{64})\s*-->/;

/**
 * Mints + verifies the server-verifiable PR gate token.
 *
 * `token = HMAC-SHA256(gateSalt, HEAD_sha)`. `wp-finish-upsert-pr` writes it into the PR body (and
 * refuses to mint it unless every BLOCK checklist passed), so a valid token IS proof the local gate ran
 * and passed on that exact commit. `wp-check-pr` in CI recomputes `HMAC(gateSalt, pr.head.sha)` from the
 * committed salt and compares — a PR opened outside the gated flow (unhooked teammate, web UI) carries
 * no valid token for its head sha and fails.
 *
 * Bound to the HEAD sha (not the title/diff) so every push needs a fresh mint: hooked devs re-run finish
 * on every push anyway (manual push is locally blocked), an unhooked bypasser's raw push does not.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is drawn in the DI design and injected by type.
 */
@injectable(bindingScopeValues.Singleton)
export class GateTokenService {
    // The raw HMAC hex for (salt, sha). Empty salt ⇒ '' (caller treats '' as "no token / disabled").
    computeGateToken(gateSalt: string, headSha: string): string {
        if (gateSalt.trim() === '' || headSha.trim() === '') return '';
        return createHmac('sha256', gateSalt).update(headSha).digest('hex');
    }

    // The hidden HTML-comment marker to append to a PR body. '' when there is no token to embed, so a
    // repo with no gateSalt gets a byte-identical PR body to before this feature existed.
    gateTokenMarker(gateSalt: string, headSha: string): string {
        const token = this.computeGateToken(gateSalt, headSha);
        return token === '' ? '' : `<!-- webpieces-pr-gate v1 token=${token} -->`;
    }

    // Pull the token hex out of a PR body (whatever else the body contains), or '' when absent.
    extractGateToken(prBody: string): string {
        const m = MARKER_RE.exec(prBody);
        return m ? m[1] : '';
    }

    // True when `prBody` carries a token that matches HMAC(gateSalt, headSha). Constant-ish comparison is
    // unnecessary here — the salt is committed/obscurity-grade, so timing side channels add no security.
    verifyGateToken(prBody: string, gateSalt: string, headSha: string): boolean {
        const expected = this.computeGateToken(gateSalt, headSha);
        if (expected === '') return false;
        return this.extractGateToken(prBody) === expected;
    }
}

// Temporary migration delegators to GateTokenService — removed once every consumer injects it.
const gateTokenSvc = new GateTokenService();

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to GateTokenService
export function computeGateToken(gateSalt: string, headSha: string): string {
    return gateTokenSvc.computeGateToken(gateSalt, headSha);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to GateTokenService
export function gateTokenMarker(gateSalt: string, headSha: string): string {
    return gateTokenSvc.gateTokenMarker(gateSalt, headSha);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to GateTokenService
export function extractGateToken(prBody: string): string {
    return gateTokenSvc.extractGateToken(prBody);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to GateTokenService
export function verifyGateToken(prBody: string, gateSalt: string, headSha: string): boolean {
    return gateTokenSvc.verifyGateToken(prBody, gateSalt, headSha);
}
