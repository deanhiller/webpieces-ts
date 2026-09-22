import { InformAiError, ReviewIdentityStampService, WRITE_REVIEW_BIN } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { HARNESS_TERMINAL } from './verdict-provenance';

/**
 * Env vars whose presence means an AI harness launched this process. Any one of them and there MUST be a
 * hook stamp — a harness-launched submission without one either bypassed the hook or ran where the hook is
 * not installed, and neither can say who is calling.
 */
const HARNESS_ENV = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID'] as const;

/** WHO is submitting a verdict. Data-only. */
export class ReviewerIdentity {
    harness: string;
    sessionId: string;
    agentId: string;
    agentType: string;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(harness: string, sessionId: string, agentId: string, agentType: string) {
        this.harness = harness;
        this.sessionId = sessionId;
        this.agentId = agentId;
        this.agentType = agentType;
    }
}

/**
 * Answers "who is running `wp-write-review`?" — and REFUSES the coordinating agent (issue #863).
 *
 * The mechanism, per harness, and why it is not the environment:
 *   - CLAUDE CODE: a Bash child inherits `CLAUDE_CODE_SESSION_ID`, which is the PARENT session's id inside
 *     a subagent too, and there is no agent id in the env at all. Env cannot tell a reviewer from its
 *     coordinator.
 *   - CODEX: `CODEX_SESSION_ID` / `CODEX_THREAD_ID` are exported, but nothing documents — and nothing here
 *     has measured — that a spawned subagent gets its own thread id instead of the coordinator's.
 *   - BOTH: the PreToolUse hook payload carries `agent_id`, empty for the main loop and set for a subagent,
 *     on the same key in both harnesses. So the hook writes a {@link ReviewIdentityStamp} for each
 *     checklist a `wp-write-review` command names, just before the command runs, and this consumes it.
 *
 * The plain-terminal story: with NO harness env and no stamp, the caller is a HUMAN at a terminal. That is
 * a legitimate reviewer, and the verdict is recorded with harness `terminal`. CI never submits verdicts —
 * `.webpieces/` is not in the repo, so there is nothing for CI to read or write here.
 *
 * NOT tamper-proof: an agent can scrub its env AND invoke the bin some way the hook does not recognise, or
 * forge a stamp file. That is deliberate, visible forgery in the transcript — the bar the rest of reviewer
 * provenance sets — rather than the one ordinary file write it used to take.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class ReviewerIdentityResolver {
    constructor(private readonly stamps: ReviewIdentityStampService) {}

    resolve(cwd: string, checklistId: string, env: NodeJS.ProcessEnv = process.env): ReviewerIdentity {
        const stamp = this.stamps.take(cwd, checklistId);
        if (stamp !== null) {
            if (this.stamps.isCoordinator(stamp)) throw new InformAiError(this.coordinatorRefusal(checklistId, stamp.aiType));
            return new ReviewerIdentity(stamp.aiType, stamp.sessionId, stamp.agentId, stamp.agentType);
        }
        const inHarness = HARNESS_ENV.filter((name: string): boolean => (env[name] ?? '').trim() !== '');
        if (inHarness.length > 0) throw new InformAiError(this.unstampedRefusal(checklistId, inHarness));
        return new ReviewerIdentity(HARNESS_TERMINAL, '', '', '');
    }

    private coordinatorRefusal(checklistId: string, aiType: string): string {
        return `${WRITE_REVIEW_BIN} REFUSED: the ${aiType} harness reports this call comes from the COORDINATING agent, not a\n`
            + `reviewer subagent. The coordinator may never submit a reviewer's verdict for "${checklistId}" — not by this\n`
            + 'bin, and not by writing the file (wp-finish-upsert-pr rejects a verdict this bin did not write).\n\n'
            + 'Spawn the reviewer subagent pnpm wp-review-upsert-pr names and hand it the instructions file; the\n'
            + 'reviewer submits its own verdict.';
    }

    private unstampedRefusal(checklistId: string, harnessEnv: readonly string[]): string {
        return `${WRITE_REVIEW_BIN} REFUSED: this process runs under an AI harness (${harnessEnv.join(', ')} set), but the\n`
            + `webpieces PreToolUse hook left no identity stamp for checklist "${checklistId}", so nothing can say whether a\n`
            + 'reviewer subagent or the coordinator is calling.\n\n'
            + `Run it as a plain Bash command the hook can read, naming the checklist literally:\n`
            + `    pnpm ${WRITE_REVIEW_BIN} --checklist ${checklistId} <<'EOF' … EOF\n`
            + 'If it already was, the webpieces hooks are not installed in this harness: pnpm wp-install-ai-hooks.';
    }
}
