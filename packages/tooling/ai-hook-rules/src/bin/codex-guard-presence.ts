import * as fs from 'fs';
import * as path from 'path';

import { injectable, bindingScopeValues } from 'inversify';

import { dotWebpieces, Option } from '@webpieces/rules-config';

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
 * ─── Where it is WIRED ────────────────────────────────────────────────────────────────────────────
 * `BuildAffected.runBuildGate` (@webpieces/pr-gate) calls it before resolving the build command, so ALL
 * THREE build entry points are covered by one call: `wp-build`, stage ② (`wp-review-upsert-pr`) and
 * stage ③ (`wp-finish-upsert-pr`). Attesting at the build is the right place because the build is the
 * moment a session's work is about to be claimed as verified — an unguarded session that never builds
 * has produced nothing to trust.
 *
 * It BLOCKS, and blocking is the whole point. This check was deliberately shipped detached for one
 * release rather than half-wired, because a check that detects and never refuses reads as coverage
 * nobody actually has.
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
@injectable(bindingScopeValues.Singleton)
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

/**
 * The answer, with the sentence a human or an agent reads. Data-only → a class, per CLAUDE.md.
 *
 * `cures` are `Option`s rather than "Fix:" lines inside `reason`, because the ONE top-level handler
 * owns the rendering of a cure list — a hand-numbered list in a string literal is an automatic review
 * reject, and it also means the two cures could not be re-ordered or counted by anything but a human
 * reading prose. Empty on both green paths: there is nothing to fix.
 */
export class GuardPresenceVerdict {
    constructor(
        /** True ⇒ the caller may proceed. False ⇒ BLOCK: a Codex session ran with no guard rows. */
        readonly ok: boolean,
        /** Why, in one line — always populated, including on the green paths. */
        readonly reason: string,
        /** How many L0 shim rows this tree has for the session under attestation. */
        readonly rows: number,
        /** What to DO about it, for the caller to hand to RuleFailError. Empty when `ok`. */
        readonly cures: readonly Option[] = [],
    ) {}
}

/**
 * The check itself: in a Codex session, REFUSE when the tree has no L0 shim rows at all.
 *
 * Outside a Codex session it is a no-op that says so, which is what makes it safe to call
 * unconditionally from a shared build path.
 */
@injectable(bindingScopeValues.Singleton)
export class CodexGuardPresence {
    // Injected BY TYPE — no Symbol token, per CLAUDE.md's DI convention. The detector is a separate
    // class because "is this Codex?" is a question other callers ask without wanting the attestation.
    constructor(private readonly detector: CodexSessionDetector) {}

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
        return new GuardPresenceVerdict(false, this.refusal(root), 0, CodexGuardPresence.CURES);
    }

    /**
     * BOTH cures, always both, in likelihood order.
     *
     * Two unrelated failures produce this one symptom, and they have DIFFERENT fixes — an agent handed
     * only the likelier one will run it, see nothing change, and conclude the check is broken. So the
     * list is fixed rather than guessed at: nothing observable at build time distinguishes "the human
     * declined the trust prompt" from "the matcher names a tool Codex never emits".
     */
    static readonly CURES: readonly Option[] = [
        new Option(
            'You answered "Continue without trusting (hooks won\'t run)" at Codex\'s hook prompt.\n'
            + 'Restart `codex` in this repo and choose "Trust all".',
            true),
        new Option(
            '.codex/hooks.json registers a matcher Codex never emits, or a shim path that does not\n'
            + 'resolve. Run EXACTLY: \'pnpm exec wp-install-ai-hooks --target=project\''),
    ];

    /**
     * The refusal's EVIDENCE — what was measured and where. The cures are Options (above); this is only
     * the finding, so the top-level handler renders the two halves in its own house style.
     */
    private refusal(root: string): string {
        return [
            'This is a Codex session and NOT ONE guard has run in this tree.',
            '',
            `  no rows in ${path.join(dotWebpieces.logs(root), L0_SHIM_STREAM)}`,
            '    → the L0 shim writes one row per tool call on EVERY path, including the healthy one, so',
            '      zero rows means the PreToolUse hook never executed. Every tool call so far was unguarded.',
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
