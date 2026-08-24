import { describe, it, expect } from 'vitest';

import { BashContext, Violation } from '../types';
import { BuildOutputPipeGuardRule } from './build-output-pipe-guard';
import { LOGGED_BUILD_COMMANDS } from './build-output-pipe-scan';

function guard(): BuildOutputPipeGuardRule {
    return new BuildOutputPipeGuardRule();
}

function ctx(command: string): BashContext {
    return new BashContext(command, '/repo');
}

function check(command: string): readonly Violation[] {
    return guard().check(ctx(command));
}

function blocked(command: string): boolean {
    return check(command).length === 1;
}

function message(command: string): string {
    return check(command)[0].message ?? '';
}

/**
 * ══ WHAT THIS GUARD IS FOR ═════════════════════════════════════════════════════════════════════════
 *
 * A pipe withholds every byte until the writing command EXITS. These three commands run a build and
 * heartbeat every ten seconds precisely so the harness can see they are alive; piped, the terminal goes
 * silent and the 600-second watchdog kills the build. Measured in this repo's own call log: 85 piped
 * `wp-*` calls, 42 of them on one of these three.
 */
describe('build-output-pipe-guard blocks bounding the output of a build that already logs', () => {
    it('blocks a pipe out of each of the three logging commands', () => {
        for (const command of LOGGED_BUILD_COMMANDS) {
            expect(blocked(`pnpm ${command} | tail -50`)).toBe(true);
        }
    });

    // `2>&1 | tail -N` is the single most common decoration an agent appends, and it is the exact shape
    // that produced the measured kills.
    it('blocks the 2>&1 | tail shape that produced the kills', () => {
        expect(blocked('pnpm wp-review-upsert-pr 2>&1 | tail -50')).toBe(true);
    });

    // The hazard is the PIPE, not what it feeds — every reader here buffers until the writer exits.
    it('blocks a pipe into anything, not just tail', () => {
        for (const reader of ['head -20', 'grep -n error', 'wc -l', 'tee /tmp/out.log', 'cat']) {
            expect(blocked(`pnpm wp-build | ${reader}`)).toBe(true);
        }
    });

    /**
     * The redirect is on the blocklist because it is the obvious way around a pipe ban, and it is the
     * same silence — plus a second copy of a log the command already wrote.
     */
    it('blocks a stdout redirect to a file, in either spelling', () => {
        expect(blocked('pnpm wp-build > /tmp/out.log')).toBe(true);
        expect(blocked('pnpm wp-finish-upsert-pr >> /tmp/out.log')).toBe(true);
    });

    it('blocks it under any package-manager wrapper, and with no wrapper at all', () => {
        for (const invocation of ['pnpm wp-build', 'pnpm exec wp-build', 'npx wp-build', 'wp-build']) {
            expect(blocked(`${invocation} | tail -5`)).toBe(true);
        }
    });

    it('blocks it mid-chain, where a scan of only the first segment would miss it', () => {
        expect(blocked('git status && pnpm wp-review-upsert-pr 2>&1 | tail -30')).toBe(true);
    });
});

describe('build-output-pipe-guard allows everything else', () => {
    // The cure. It must never be blocked, or the guard has no accepted spelling.
    it('allows the bare command — the cure it prescribes', () => {
        for (const command of LOGGED_BUILD_COMMANDS) {
            expect(check(`pnpm ${command}`)).toEqual([]);
        }
    });

    // `2>&1` rewires fds and buffers nothing. Treating it as a redirect would block the cure's own
    // commonest spelling for no benefit — ShellSegmentScan owns that carve-out and it is shared.
    it('allows a bare 2>&1 with no pipe after it', () => {
        expect(check('pnpm wp-build 2>&1')).toEqual([]);
    });

    it('allows piping a command that does NOT write a log of its own', () => {
        expect(check('pnpm wp-cleanup --report | tail -40')).toEqual([]);
        expect(check('git log --oneline | head -5')).toEqual([]);
    });

    // Reading the log is the whole point of the refusal, so it can never itself be refused.
    it('allows grepping and tailing the log file the command wrote', () => {
        expect(check('grep -n error /repo/.webpieces/build.log')).toEqual([]);
        expect(check('tail -50 /repo/.webpieces/logs/wp-review-upsert-pr.log')).toEqual([]);
    });

    it('allows a chain that merely MENTIONS the command in prose', () => {
        expect(check('echo "run pnpm wp-build | tail" >> notes.md')).toEqual([]);
    });
});

describe('build-output-pipe-guard message', () => {
    it('names the bare command to run instead, and the log to grep', () => {
        const text = message('pnpm wp-review-upsert-pr 2>&1 | tail -50');
        expect(text).toContain('pnpm wp-review-upsert-pr');
        expect(text).toContain('FullLog');
        expect(text).toContain('600s');
    });

    it('says which of the two shapes it caught, so the reader knows what to remove', () => {
        expect(message('pnpm wp-build | tail -5')).toContain('you piped');
        expect(message('pnpm wp-build > /tmp/o.log')).toContain('you redirected');
    });

    it('stays short — a guard message is read mid-task, not studied', () => {
        expect(message('pnpm wp-build | tail -5').split('\n').length).toBeLessThanOrEqual(8);
    });

    /**
     * The cures are `Option`s, rendered by the framework's `formatFixOptions`. Hand-numbering them into
     * a string literal is an automatic review reject, so this is the test that goes red if anybody does.
     */
    it('offers the bare command first, as Options the framework numbers', () => {
        const hint = guard().fixHint;
        expect(hint.fixOptions.length).toBeGreaterThan(1);
        expect(hint.fixOptions[0].preferred).toBe(true);
        expect(hint.fixOptions[0].text).toContain('with nothing after it');
        expect(hint.fixOptions[1].text).toContain('grep -n error');
        expect(hint.mainMessage).not.toContain('Fix Option');
        expect(hint.violation).not.toContain('Fix Option');
    });

    /**
     * `fixHint` is static per-rule and cannot see WHICH command was piped, so any command it spelled
     * would be wrong for two of the three. It named `wp-build` at a caller who piped
     * `wp-review-upsert-pr` — a cure that does not match the block, which is the "message teaches a
     * cure that does not exist" shape the error-output checklist rejects. The bare command is printed
     * once, by `message(hit)`, which is the only place that knows it.
     */
    it.each(LOGGED_BUILD_COMMANDS)('names %s in the message, and no command in the static cures',
        (command: string) => {
            expect(message(`pnpm ${command} | tail -5`)).toContain(`pnpm ${command}`);
            for (const option of guard().fixHint.fixOptions) {
                for (const other of LOGGED_BUILD_COMMANDS) expect(option.text).not.toContain(other);
            }
        });

    // A guard whose cure a reader cannot find is a guard that gets worked around.
    it('names the .bak, so comparing two runs needs no third one', () => {
        expect(guard().fixHint.fixOptions.some((o: { text: string }): boolean => o.text.includes('.bak'))).toBe(true);
    });
});
