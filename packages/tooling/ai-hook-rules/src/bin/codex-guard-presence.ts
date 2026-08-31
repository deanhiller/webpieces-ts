import * as fs from 'fs';
import * as path from 'path';

import { dotWebpieces } from '@webpieces/rules-config';

import { L0_SHIM_STREAM } from '../core/log-streams';
import { toError } from '../core/to-error';

/**
 * GUARD-PRESENCE ATTESTATION — "did the guards actually RUN in this Codex session?"
 *
 * ─── The hole this closes ─────────────────────────────────────────────────────────────────────────
 * Codex prompts before running a hook it has not trusted, and the prompt's third option is
 * `Continue without trusting (hooks won't run)`. One keystroke, no later warning, and the session is
 * fully unguarded for its whole life. Nothing at INSTALL time can see that choice — it is made
 * afterwards, in another process — so `codex-trust.ts` reading `~/.codex/config.toml` is necessary and
 * not sufficient.
 *
 * The same check catches a second, quieter failure with no relation to trust: a matcher that names a
 * tool Codex does not emit. That was the live state of every `.codex/hooks.json` a desktop sync had
 * written — `Write|Edit|MultiEdit` against a harness whose file tool is `apply_patch` — and it produced
 * exactly the same symptom, which is no symptom at all.
 *
 * ─── Why the L0 shim log is the evidence ──────────────────────────────────────────────────────────
 * The L0 shim writes one row per tool call, on EVERY path including the healthy one, before anything
 * else can fail. So a session that produced ZERO rows did not have a guard run — that is the whole
 * inference, and it holds no matter WHY (untrusted, wrong matcher, deleted file, unresolvable path).
 *
 * It is deliberately a count of rows and not a check of any row's content: what is being attested is
 * that the hook EXECUTED, not what it decided.
 *
 * ─── Scope, stated honestly ───────────────────────────────────────────────────────────────────────
 * This is a REUSABLE CHECK, not yet a gate. `check()` returns a verdict and a message; wiring it into
 * `wp-build` and the PR gate's build stage is a follow-up, because the build path lives in a different
 * published package (`@webpieces/pr-gate`) and a half-wired gate — one that detects but never blocks —
 * would be worse than none: it would read as coverage nobody has.
 */

/**
 * Is THIS process running inside a Codex session?
 *
 * MEASURED (codex-cli 0.151.0), and the negative half matters as much as the positive: there is NO
 * `CODEX_SESSION_ID`. Reaching for one is the obvious thing to do and it does not exist, so the
 * fingerprints are the three that DO: `CODEX_MANAGED_BY_NPM`, `CODEX_MANAGED_PACKAGE_ROOT`, and a
 * `/.codex/tmp/arg0/` entry on `PATH`.
 *
 * Any one of them is enough. They come from different install shapes, and requiring all three would
 * silently answer "not Codex" — which for a check that BLOCKS on absence of evidence is the dangerous
 * direction: it would turn an unguarded session into an unchecked one.
 */
export class CodexSessionDetector {
    /** The env keys that identify a Codex-managed process. */
    static readonly ENV_KEYS: readonly string[] = ['CODEX_MANAGED_BY_NPM', 'CODEX_MANAGED_PACKAGE_ROOT'];

    /** The PATH segment Codex injects for its arg0 shims. */
    static readonly PATH_MARKER = '/.codex/tmp/arg0/';

    isCodexSession(env: NodeJS.ProcessEnv = process.env): boolean {
        for (const key of CodexSessionDetector.ENV_KEYS) {
            const value = env[key];
            if (value !== undefined && value !== '') return true;
        }
        const search = env['PATH'] ?? '';
        return search.includes(CodexSessionDetector.PATH_MARKER);
    }
}

/** The answer, with the sentence a human or an agent reads. Data-only → a class, per CLAUDE.md. */
export class GuardPresenceVerdict {
    constructor(
        /** True ⇒ the caller may proceed. False ⇒ BLOCK: a Codex session ran with no guard rows. */
        readonly ok: boolean,
        /** Why, in one line — always populated, including on the green paths. */
        readonly reason: string,
        /** How many L0 shim rows this tree has for the session under attestation. */
        readonly rows: number,
    ) {}
}

/**
 * The check itself: in a Codex session, REFUSE when the tree has no L0 shim rows at all.
 *
 * Outside a Codex session it is a no-op that says so, which is what makes it safe to call
 * unconditionally from a shared build path.
 */
export class CodexGuardPresence {
    private readonly detector = new CodexSessionDetector();

    /**
     * `root` is the tree whose `.webpieces` logs are the evidence — the same root every other webpieces
     * writer resolves, so a worktree is attested by its own rows rather than the primary clone's.
     */
    check(root: string, env: NodeJS.ProcessEnv = process.env): GuardPresenceVerdict {
        if (!this.detector.isCodexSession(env)) {
            return new GuardPresenceVerdict(true, 'not a Codex session — guard presence is not attested here', 0);
        }
        const rows = this.shimRowCount(root);
        if (rows > 0) {
            return new GuardPresenceVerdict(true, `Codex session with ${String(rows)} L0 guard row(s) — the guards ran`, rows);
        }
        return new GuardPresenceVerdict(false, this.refusal(root), 0);
    }

    /**
     * The refusal text. It names the two causes that produce this identical symptom, because they have
     * DIFFERENT cures and an agent handed only one of them will run it, see nothing change, and conclude
     * the check is broken.
     */
    private refusal(root: string): string {
        return [
            '❌ webpieces: this is a Codex session and NOT ONE guard has run in this tree.',
            '',
            `  no rows in ${path.join(dotWebpieces.logs(root), L0_SHIM_STREAM)}`,
            '    → the L0 shim writes one row per tool call on EVERY path, including the healthy one, so',
            '      zero rows means the PreToolUse hook never executed. Every tool call so far was unguarded.',
            '',
            '  Cause 1 (most likely): you answered "Continue without trusting (hooks won\'t run)" at Codex\'s',
            '    hook prompt. Fix: restart `codex` in this repo and choose "Trust all".',
            '  Cause 2: .codex/hooks.json registers a matcher Codex never emits, or a shim path that does',
            '    not resolve. Fix: run EXACTLY: \'pnpm exec wp-install-ai-hooks --target=project\'',
        ].join('\n');
    }

    /** How many `.log` lines the L0 shim stream holds for this tree. Never throws; 0 on any failure. */
    private shimRowCount(root: string): number {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const streamDir = path.join(dotWebpieces.logs(root), L0_SHIM_STREAM);
            if (!fs.existsSync(streamDir)) return 0;
            let rows = 0;
            for (const name of fs.readdirSync(streamDir)) {
                if (!name.endsWith('.log')) continue;
                const body = fs.readFileSync(path.join(streamDir, name), 'utf8');
                rows += body.split('\n').filter((line: string): boolean => line.trim() !== '').length;
            }
            return rows;
        } catch (err: unknown) {
            const error = toError(err);
            void error; // an unreadable log dir is ZERO rows — the direction that refuses rather than waves through
            return 0;
        }
    }
}
