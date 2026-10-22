import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { GateLogFile } from './gate-log-file';
import { CheckoutLayout, MockProcessExitApi, MockProcessExited } from '@webpieces/tooling-testkit';
import { CliExitError, Option, RuleFailError, runMain } from '@webpieces/rules-config';
import { toError } from '@webpieces/tooling-common/to-error';
import { StageOutputLog, REVIEW_CONSOLE_LOG, FINISH_CONSOLE_LOG } from './stage-output-log';


let tmp = '';
let primary = '';
let worktree = '';
let files: GateLogFile;
let stage: StageOutputLog;
let terminal = '';
let restoreTerminal: (() => void) | null = null;


/**
 * Stand in for the TERMINAL. Installed BEFORE `withCapture`, so what this collects is exactly what
 * survived the capture — which is the whole subject of this suite.
 */
function watchTerminal(): void {
    const real = process.stdout.write.bind(process.stdout);
    // webpieces-disable no-any-unknown -- matching node's overloaded write signature for a test double
    process.stdout.write = ((chunk: string): boolean => { terminal += chunk; return true; }) as
        typeof process.stdout.write;
    restoreTerminal = (): void => { process.stdout.write = real; };
}

beforeEach(() => {
    tmp = specTempDirs.makeReal('wp-stagelog-');
    primary = path.join(tmp, 'primary');
    worktree = path.join(tmp, 'wt-feature');
    fs.mkdirSync(primary, { recursive: true });
    // The layout git leaves, written directly (#1381): placement is decided by reading these files, so no
    // git process is needed to prove it.
    CheckoutLayout.primaryWithWorktree(primary, worktree, 'feature');
    files = new GateLogFile();
    stage = new StageOutputLog(files);
    terminal = '';
    watchTerminal();
});

afterEach(() => {
    if (restoreTerminal !== null) restoreTerminal();
    restoreTerminal = null;
    fs.rmSync(tmp, { recursive: true, force: true });
});

function logPath(root: string, name = REVIEW_CONSOLE_LOG): string {
    return path.join(path.dirname(files.logsPath(root, name)), name);
}

function readLog(root: string, name = REVIEW_CONSOLE_LOG): string {
    return fs.readFileSync(logPath(root, name), 'utf8');
}

/**
 * ══ WHY ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Stage ② and stage ③ printed everything they did. An agent that expects a flood bounds it — and a PIPE
 * withholds every byte until the command exits, so the harness's 600-second no-output watchdog kills a
 * command that has just run a full build. Shrinking what reaches the terminal is the FIRST half of the
 * fix; the guard against the pipe is the second, and it would backfire on its own.
 */
describe('StageOutputLog captures the verbose body', () => {
    it('sends an ordinary write to the FILE and not to the terminal', async () => {
        await stage.withCapture(primary, REVIEW_CONSOLE_LOG, async (): Promise<void> => {
            process.stdout.write('a very long dashboard\n');
            return Promise.resolve();
        });
        expect(readLog(primary)).toContain('a very long dashboard');
        expect(terminal).not.toContain('a very long dashboard');
    });

    it('sends a `say` to BOTH — that is what the caller must act on now', async () => {
        await stage.withCapture(primary, REVIEW_CONSOLE_LOG, async (): Promise<void> => {
            stage.say('spawn these reviewers\n');
            return Promise.resolve();
        });
        expect(terminal).toContain('spawn these reviewers');
        expect(readLog(primary)).toContain('spawn these reviewers');
    });

    // The heartbeat is a `say` for exactly this reason: a heartbeat captured into a file is a heartbeat
    // nobody can see, and the watchdog that kills a silent command does not read files.
    it('leaves the terminal with a pointer at the file when the body printed nothing else', async () => {
        await stage.withCapture(primary, REVIEW_CONSOLE_LOG, async (): Promise<void> => {
            process.stdout.write('noise\n');
            return Promise.resolve();
        });
        expect(terminal).toContain(`FullLog : ${logPath(primary)}`);
    });

    it('returns the body\'s value', async () => {
        const answer = await stage.withCapture(primary, REVIEW_CONSOLE_LOG,
            (): Promise<number> => Promise.resolve(42));
        expect(answer).toBe(42);
    });
});

describe('StageOutputLog always restores stdout', () => {
    it('restores it after a normal run', async () => {
        const before = process.stdout.write;
        await stage.withCapture(primary, REVIEW_CONSOLE_LOG, (): Promise<void> => Promise.resolve());
        expect(process.stdout.write).toBe(before);
    });

    /**
     * The failure path is the one that matters. A stage that throws — a red build, a refused checklist —
     * must not leave the PROCESS with a patched stdout, or `runMain`'s own rendering would vanish.
     */
    it('restores it — and still points at the log — when the body throws', async () => {
        const before = process.stdout.write;
        await expect(stage.withCapture(primary, REVIEW_CONSOLE_LOG, (): Promise<void> => {
            process.stdout.write('work so far\n');
            return Promise.reject(new Error('build failed'));
        })).rejects.toThrow('build failed');
        expect(process.stdout.write).toBe(before);
        expect(terminal).toContain(`FullLog : ${logPath(primary)}`);
        expect(readLog(primary)).toContain('work so far');
        expect(readLog(primary)).toContain('build failed');
    });

    it('refuses to nest rather than silently restoring the wrong stdout', async () => {
        await expect(stage.withCapture(primary, REVIEW_CONSOLE_LOG, (): Promise<void> =>
            stage.withCapture(primary, FINISH_CONSOLE_LOG, (): Promise<void> => Promise.resolve())))
            .rejects.toThrow('already capturing');
    });
});

describe('StageOutputLog outside a capture', () => {
    it('writes `say` straight to the terminal, so a shared collaborator needs no stage', () => {
        stage.say('heartbeat\n');
        expect(terminal).toContain('heartbeat');
    });
});

describe('StageOutputLog file placement', () => {
    /**
     * Same rule as every other gate log: a linked worktree's file lands under the PRIMARY clone,
     * namespaced by git's worktree name, so it survives the worktree being reaped and cannot collide
     * with another agent's.
     */
    it('namespaces a linked worktree under the primary clone', async () => {
        await stage.withCapture(worktree, REVIEW_CONSOLE_LOG, (): Promise<void> => Promise.resolve());
        const expected = path.join(primary, '.webpieces', 'worktrees', 'wt-feature', 'logs', REVIEW_CONSOLE_LOG);
        expect(fs.existsSync(expected)).toBe(true);
    });

    it('gives the two stages separate files', async () => {
        await stage.withCapture(primary, REVIEW_CONSOLE_LOG, (): Promise<void> => Promise.resolve());
        await stage.withCapture(primary, FINISH_CONSOLE_LOG, (): Promise<void> => Promise.resolve());
        expect(fs.existsSync(logPath(primary, REVIEW_CONSOLE_LOG))).toBe(true);
        expect(fs.existsSync(logPath(primary, FINISH_CONSOLE_LOG))).toBe(true);
    });

    // Same one-generation rule as build.log: re-running a stage does not destroy the run before it.
    it('keeps the previous run as .bak', async () => {
        await stage.withCapture(primary, REVIEW_CONSOLE_LOG, (): Promise<void> => {
            process.stdout.write('first\n');
            return Promise.resolve();
        });
        await stage.withCapture(primary, REVIEW_CONSOLE_LOG, (): Promise<void> => {
            process.stdout.write('second\n');
            return Promise.resolve();
        });
        expect(readLog(primary)).toContain('second');
        expect(readLog(primary)).not.toContain('first');
        expect(fs.readFileSync(files.backupPathFor(logPath(primary)), 'utf8')).toContain('first');
    });
});

/**
 * The global CLI handler (`runMain`) driven IN PROCESS (#1381). Its exit goes through the ProcessExitApi
 * edge: `MockProcessExitApi` records the code and STOPS the run by throwing, exactly where the real exit
 * would end the process — so nothing runMain would never have run after exiting runs here either, and
 * the ordering the old node child proved (the failure is recorded in the log before it is closed and
 * before the process ends) is still what is asserted.
 */
class TerminalRun {
    constructor(readonly code: number | null, readonly stderr: string) {}
}

async function runThroughCliHandler(failure: () => unknown): Promise<TerminalRun> {
    const exit = new MockProcessExitApi();
    let stderr = '';
    const realStderr = process.stderr.write.bind(process.stderr);
    // webpieces-disable no-any-unknown -- matching node's overloaded write signature for a test double
    process.stderr.write = ((chunk: string): boolean => { stderr += chunk; return true; }) as typeof process.stderr.write;
    const ended = await runMain(() => new StageOutputLog(new GateLogFile()).withCapture(primary,
        REVIEW_CONSOLE_LOG, async (): Promise<void> => {
            process.stdout.write('before failure\n');
            throw failure();
        }), exit).then(
        (): Error | null => null,
        (err: unknown): Error => toError(err));
    process.stderr.write = realStderr;
    expect(ended).toBeInstanceOf(MockProcessExited);
    return new TerminalRun(exit.codes[0] ?? null, stderr);
}

const FAILURES: readonly [string, () => unknown][] = [
    ['new Error("build failed")', (): unknown => new Error('build failed')],
    ['"non-Error rejection"', (): unknown => 'non-Error rejection'],
    ['new CliExitError(2, "terminal refusal")', (): unknown => new CliExitError(2, 'terminal refusal')],
    ['new RuleFailError("test", "ai refusal", undefined, undefined, [new Option("repair this", true)], "human refusal")',
        (): unknown => new RuleFailError('test', 'ai refusal', undefined, undefined, [new Option('repair this', true)], 'human refusal')],
];

describe('stage failure diagnostics survive the global CLI handler', () => {
    it.each(FAILURES)('records the normalized failure before closure: %s', async (failure: string, make: () => unknown) => {
        const result = await runThroughCliHandler(make);

        expect(result.code).toBe(failure.startsWith('new CliExitError') ? 2 : 1);
        const message = result.stderr.trim();
        if (failure.startsWith('new RuleFailError')) {
            expect(message).toContain('human refusal');
            expect(message).toContain('repair this');
        } else {
            expect(message).toBe(
                failure.startsWith('new Error')
                    ? 'build failed'
                    : failure.startsWith('new CliExitError')
                      ? 'terminal refusal'
                      : 'non-Error rejection',
            );
        }
        expect(readLog(primary)).toContain(message);
        expect(terminal).toContain(`FullLog : ${logPath(primary)}`);
        expect(readLog(primary).indexOf('before failure')).toBeLessThan(
            readLog(primary).indexOf(message),
        );
    });
});
