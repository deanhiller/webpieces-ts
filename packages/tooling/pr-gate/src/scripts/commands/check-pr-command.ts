import { spawnSync } from 'child_process';
import {
    loadAndValidate, RepoRootFinder, GateTokenService, CliExitError,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

// The head sha + body of the PR under check, resolved from `gh`. Data-only.
class PrUnderCheck {
    number: string;
    headSha: string;
    body: string;

    constructor(number: string, headSha: string, body: string) {
        this.number = number;
        this.headSha = headSha;
        this.body = body;
    }
}

/**
 * `wp-check-pr` — the SERVER-SIDE half of the gate, meant to run as a required CI check. It is READ-ONLY:
 * it never touches git state, never pushes, never calls `gh pr create`. It recomputes
 * `HMAC(prGate.gateSalt, PR_head_sha)` from the committed salt and verifies the PR body carries that
 * token. Because `wp-finish-upsert-pr` refuses to mint the token unless the build gate + every BLOCK
 * checklist passed, a valid token IS proof the gated flow ran and passed on this exact commit.
 *
 * This is what catches a PR opened OUTSIDE the gated flow — an unhooked teammate who `git push`ed and
 * clicked "Create pull request" in the web UI carries no valid token for its head sha and fails here.
 *
 * This job is THE required check — the ONE thing a consumer marks required in branch protection. It used
 * to also post a `webpieces/pr-gate` commit status, because `wp-finish-upsert-pr` pushed BEFORE writing
 * the PR body and a status (newest post wins for a context) could supersede the failure that race caused.
 * GatedPrPublisher now writes the body first, so there is no race to recover from and no second entry to
 * confuse anyone about which one to require. This job's exit code is the whole verdict.
 *
 * A repo with no `gateSalt` configured has not opted in → this is a no-op success (exit 0), so it is safe
 * to add the workflow before turning enforcement on.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is drawn in the DI design and resolved by PrGateApp.
 */
@injectable(bindingScopeValues.Singleton)
export class CheckPrCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly gateTokenService: GateTokenService,
    ) {}

    async run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        const gateSalt = loadAndValidate(repoRoot).prGate.gateSalt;
        if (gateSalt.trim() === '') {
            throw new CliExitError(0,
                'ℹ️  wp-check-pr: no prGate.gateSalt configured — server-side gate token enforcement is disabled. ' +
                'Add a committed "gateSalt" under the pr-gate section of webpieces.config.json to enable it.');
        }

        let pr = this.resolvePr();
        if (pr.headSha === '') {
            throw new CliExitError(1,
                '❌ wp-check-pr: could not resolve the PR head sha via `gh`. Ensure the workflow runs on a pull_request ' +
                'event with `gh` authenticated (GH_TOKEN) and the PR number available (WP_PR_NUMBER or GITHUB_REF).');
        }

        pr = await this.verifyWithRetry(pr, gateSalt);
        if (this.gateTokenService.verifyGateToken(pr.body, gateSalt, pr.headSha)) {
            process.stdout.write(`✅ wp-check-pr: valid webpieces gate token for PR #${pr.number} @ ${pr.headSha.slice(0, 12)} — created through the gated flow.\n`);
            return;
        }

        // An UNHOOKED push never reaches wp-finish-upsert-pr, so it carries no valid token — fail the job.
        // THIS EXIT CODE IS THE WHOLE SIGNAL: there is no companion commit status any more (see the JSDoc).
        throw new CliExitError(1, this.failureMessage(pr));
    }

    // Re-read the PR ONCE after a short delay if the token looks stale. The push-before-body-edit RACE is
    // gone (GatedPrPublisher writes the body first), so this no longer backstops a known ordering bug —
    // it absorbs GitHub's own event/read replication jitter, which matters more now that this job is the
    // single required check. It costs nothing on the success path. Returns the freshest PR.
    private async verifyWithRetry(pr: PrUnderCheck, gateSalt: string): Promise<PrUnderCheck> {
        if (this.gateTokenService.verifyGateToken(pr.body, gateSalt, pr.headSha)) return pr;
        process.stdout.write('… no valid token yet — waiting for the PR body edit to land, then re-checking once…\n');
        await this.delay(15000);
        const refreshed = this.resolvePr();
        return refreshed.headSha !== '' ? refreshed : pr;
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve: () => void): void => {
            setTimeout(resolve, ms);
        });
    }

    // The actionable red-check message: this PR did not come through the gated flow (or hooks are missing).
    private failureMessage(pr: PrUnderCheck): string {
        return (
            `❌ wp-check-pr: PR #${pr.number} (head ${pr.headSha.slice(0, 12)}) has no valid webpieces gate token.\n\n` +
            `This PR was NOT created through the webpieces gated flow — or was pushed after finishing without re-running it.\n` +
            `Every commit that lands here must go through it, so:\n\n` +
            `  1. Install the webpieces hooks if you don't have them.\n` +
            `  2. Recreate/update this PR by running:  pnpm wp-start-upsert-pr  → write review.json → pnpm wp-finish-upsert-pr\n\n` +
            `That re-stamps the PR title, body, and the gate token for the current head commit, and this check goes green.`
        );
    }

    // Resolve the PR (number, head sha, body) from `gh`. Prefers an explicit WP_PR_NUMBER, then the
    // pull_request number in GITHUB_REF (refs/pull/<n>/merge), then `gh`'s current-branch detection.
    private resolvePr(): PrUnderCheck {
        const num = this.prNumber();
        const args = num !== ''
            ? ['pr', 'view', num, '--json', 'number,headRefOid,body', '--jq', '"\\(.number)\\t\\(.headRefOid)\\t\\(.body)"']
            : ['pr', 'view', '--json', 'number,headRefOid,body', '--jq', '"\\(.number)\\t\\(.headRefOid)\\t\\(.body)"'];
        const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 });
        if (result.status !== 0) return new PrUnderCheck(num, '', '');
        // jq joins body (which may contain tabs/newlines) last, so split on the FIRST two tabs only.
        const out = (result.stdout ?? '').trim();
        const firstTab = out.indexOf('\t');
        const secondTab = firstTab >= 0 ? out.indexOf('\t', firstTab + 1) : -1;
        if (firstTab < 0 || secondTab < 0) return new PrUnderCheck(num, '', '');
        const number = out.slice(0, firstTab);
        const headSha = out.slice(firstTab + 1, secondTab);
        const body = out.slice(secondTab + 1);
        return new PrUnderCheck(number, headSha, body);
    }

    private prNumber(): string {
        const explicit = (process.env['WP_PR_NUMBER'] ?? '').trim();
        if (explicit !== '') return explicit;
        // GitHub Actions pull_request: GITHUB_REF = refs/pull/<n>/merge
        const ref = process.env['GITHUB_REF'] ?? '';
        const m = /refs\/pull\/(\d+)\//.exec(ref);
        return m ? m[1] : '';
    }
}
