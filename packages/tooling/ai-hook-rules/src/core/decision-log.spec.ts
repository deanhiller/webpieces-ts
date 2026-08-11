import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeMainSyncStatus, MainSyncStatus, CLAUDE_PROJECT_DIR_ENV, CLAUDE_PROJECT_DIR_UNSET } from '@webpieces/rules-config';

import { InvocationLog, logGuardDecision, GuardDecision, Verdict , MATRIX_L2_UNROWED } from './decision-log';

// Log FILENAMES now carry the stream prefix (see LogStream). Specs resolve the name the same way
// production does, so the layout is regression-tested on the REAL path rather than a fallback.
import { LogStream } from './log-stream';
import { L2_DECISIONS_STREAM, CALLS_STREAM, ASYNC_REFRESH_STREAM, REJECTIONS_STREAM } from './log-streams';
import { L0_FAULT_NONE } from './l0-fault-codes';
// One writer's path inside a STREAM DIRECTORY — `<stream>/<sessionId>-<agent>-<hook><suffix>`, the
// real layout production builds. Takes the stream CONSTANT, so no dead filename survives in a fixture.
function streamName(stream: string, suffix: string = '.log'): string {
    return path.join(stream, new LogStream().writerFile(suffix));
}


function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-guardinv-'));
}

// One invocation, begin-to-end, the way the hook does it: capture on entry, flush at the terminal
// boundary. Every assertion below reads the file that flush produced.
function logOne(root: string, tool: string, target: string, verdict: Verdict = 'ALLOW', rule: string = '-'): void {
    const log = new InvocationLog();
    log.begin(root, tool, target);
    log.finish(verdict, rule);
}

const LOG_REL = `.webpieces/logs/${streamName(CALLS_STREAM)}`;
const DECISION_LOG_REL = `.webpieces/logs/${streamName(L2_DECISIONS_STREAM)}`;

// The temp dirs are not git repos and have no webpieces.config.json, so resolveRepoRoot falls back to
// the passed dir (the temp root) and branchForLog returns 'unknown' — exactly the fail-open behavior
// we want to assert stays non-fatal.
describe('InvocationLog', () => {
    it('appends one tab-separated line with tool, target, branch and sync=none when no cache exists', () => {
        const root = tmpRoot();
        logOne(root, 'Bash', 'pnpm run build-all');
        const content = fs.readFileSync(path.join(root, LOG_REL), 'utf8');
        expect(content).toContain('\tBash\t');
        expect(content).toContain('pnpm run build-all');
        expect(content).toContain('branch=');
        expect(content).toContain('sync=none');
        expect(content.trim().split('\n').length).toBe(1);
    });

    // The cache is branch-KEYED, so the entry folded in is the one for the branch we are standing on.
    // These temp dirs are not git repos, so branchForLog reports 'unknown' — writing the entry under
    // that name is how the test names the branch the logger will actually look up. The sibling entry
    // proves it takes ITS branch's row rather than whatever happens to be in the file.
    it('folds the main-sync-status.json fields (branch, merged PR, fork, conflict) into the line', () => {
        const root = tmpRoot();
        writeMainSyncStatus(
            root,
            new MainSyncStatus('dean/other', false, '', true, 'zzz', 'o', 'f', true, ['a.ts'], 'ts'),
        );
        writeMainSyncStatus(
            root,
            new MainSyncStatus('unknown', true, '271', true, 'abc123', 'o', 'f', false, [], '2026-07-06T00:00:00.000Z'),
        );
        logOne(root, 'Edit', 'src/x.ts');
        const content = fs.readFileSync(path.join(root, LOG_REL), 'utf8');
        expect(content).toContain('\tEdit\t');
        expect(content).toContain('sync=unknown');
        expect(content).toContain('merged=PR#271');
        expect(content).toContain('fork=true');
        expect(content).toContain('conflict=false');
    });

    // A cache that describes only OTHER branches is a MISS for this one — sync=none, the same
    // fail-open the logger already showed for a cache that had not been written yet.
    it('logs sync=none when the cache describes only other branches', () => {
        const root = tmpRoot();
        writeMainSyncStatus(
            root,
            new MainSyncStatus('dean/other', true, '271', true, 'abc', 'o', 'f', false, [], 'ts'),
        );
        logOne(root, 'Edit', 'src/x.ts');
        expect(fs.readFileSync(path.join(root, LOG_REL), 'utf8')).toContain('sync=none');
    });

    it('collapses newlines/tabs in the target so one invocation is always one line', () => {
        const root = tmpRoot();
        logOne(root, 'Bash', 'echo one\ntwo\tthree');
        const content = fs.readFileSync(path.join(root, LOG_REL), 'utf8');
        expect(content.trim().split('\n').length).toBe(1);
        expect(content).toContain('echo one two three');
    });

    it('rotates the writer into its .1.log sibling once the log exceeds the size cap', () => {
        const root = tmpRoot();
        const logsDir = path.join(root, '.webpieces/logs');
        // streamName() already carries the stream segment, so only the DIRECTORY needs creating here.
        fs.mkdirSync(path.join(logsDir, CALLS_STREAM), { recursive: true });
        fs.writeFileSync(path.join(logsDir, streamName(CALLS_STREAM)), 'x'.repeat(512 * 1024 + 10));
        logOne(root, 'Bash', 'ls');
        expect(fs.existsSync(path.join(logsDir, streamName(CALLS_STREAM, '.1.log')))).toBe(true);
        expect(fs.readFileSync(path.join(logsDir, streamName(CALLS_STREAM)), 'utf8')).toContain('\tBash\t');
    });

    // The read-only fast path (hook-core.ts) logs a Read via this same class, so the file the AI
    // opened lands in the `calls/` stream — this is the "did it read design.json first?" signal.
    it('records a Read of a design.json so opened files are visible in the history', () => {
        const root = tmpRoot();
        logOne(root, 'Read', 'packages/tooling/pr-gate/design.json');
        const content = fs.readFileSync(path.join(root, LOG_REL), 'utf8');
        expect(content).toContain('\tRead\t');
        expect(content).toContain('packages/tooling/pr-gate/design.json');
    });
});

/**
 * THE VERDICT FIELDS. A line that says what the guard SAW but not what it DID forced every "what
 * happened to this call?" question through a timestamp join against the L2 decision stream. These
 * lock the outcome onto the invocation stream itself.
 */
describe('InvocationLog — the outcome lives on the invocation line', () => {
    it('stamps an allowed call guards=ALLOW with no blocking rule', () => {
        const root = tmpRoot();
        logOne(root, 'Bash', 'ls');
        const content = fs.readFileSync(path.join(root, LOG_REL), 'utf8');
        expect(content).toContain('\tguards=ALLOW\t');
        expect(content).toContain('\trule=-\t');
    });

    it('stamps a blocked call guards=BLOCK_AI_CURE AND names the rule that blocked it', () => {
        const root = tmpRoot();
        logOne(root, 'Bash', 'gh pr create -t x', 'BLOCK_AI_CURE', 'redirect-how-to-create-pr');
        const content = fs.readFileSync(path.join(root, LOG_REL), 'utf8');
        expect(content).toContain('\tguards=BLOCK_AI_CURE\t');
        expect(content).toContain('\trule=redirect-how-to-create-pr\t');
    });

    // APPEND-ONLY. Cleanup automation mines this file by position, so the five original fields must
    // keep their indices and the new ones must sit after them.
    it('appends the new fields without reordering the five original ones', () => {
        const root = tmpRoot();
        logOne(root, 'Bash', 'ls');
        const fields = fs.readFileSync(path.join(root, LOG_REL), 'utf8').trim().split('\t');
        expect(fields[1]).toBe('Bash');
        expect(fields[2]).toBe('ls');
        expect(fields[3].startsWith('branch=')).toBe(true);
        expect(fields[4].startsWith('sync=')).toBe(true);
        expect(fields[5]).toBe('guards=ALLOW');
        expect(fields[6]).toBe('rule=-');
    });

    // begin() without finish() writes NOTHING, and finish() without begin() is a no-op rather than a
    // half-populated line: a stream whose whole value is "one line per call, with its outcome" must
    // never emit a line whose outcome is a guess.
    it('writes nothing until the outcome is known, and never double-writes', () => {
        const root = tmpRoot();
        const log = new InvocationLog();
        log.begin(root, 'Bash', 'ls');
        expect(fs.existsSync(path.join(root, LOG_REL))).toBe(false);
        log.finish('ALLOW', '-');
        log.finish('BLOCK_AI_CURE', 'x');   // a second terminal boundary must add nothing
        expect(fs.readFileSync(path.join(root, LOG_REL), 'utf8').trim().split('\n').length).toBe(1);
    });
});

/**
 * CLAUDE_PROJECT_DIR, recorded next to the root the guard actually used.
 *
 * This exists to settle an open question empirically (see ClaudeEnv): whether Claude Code points that
 * variable at the primary clone or at the linked worktree an agent is working in. The two fields are
 * only useful TOGETHER — the bug signature is them disagreeing — so both are asserted here, including
 * the unset case, which must be distinguishable from a present-but-empty value.
 */
describe('InvocationLog — CLAUDE_PROJECT_DIR and the tree actually used', () => {
    it('records the variable and the resolved root when it is set', () => {
        const root = tmpRoot();
        const previous = process.env[CLAUDE_PROJECT_DIR_ENV];
        process.env[CLAUDE_PROJECT_DIR_ENV] = '/some/primary/clone';
        logOne(root, 'Bash', 'ls');
        if (previous === undefined) delete process.env[CLAUDE_PROJECT_DIR_ENV];
        else process.env[CLAUDE_PROJECT_DIR_ENV] = previous;

        const content = fs.readFileSync(path.join(root, LOG_REL), 'utf8');
        expect(content).toContain('\tprojectDir=/some/primary/clone');
        expect(content).toContain(`\troot=${root}\t`);
    });

    it('records an ABSENT variable as <unset>, distinguishably from a present-but-empty one', () => {
        const root = tmpRoot();
        const previous = process.env[CLAUDE_PROJECT_DIR_ENV];
        delete process.env[CLAUDE_PROJECT_DIR_ENV];
        logOne(root, 'Bash', 'ls');
        const unsetLine = fs.readFileSync(path.join(root, LOG_REL), 'utf8');

        const emptyRoot = tmpRoot();
        process.env[CLAUDE_PROJECT_DIR_ENV] = '';
        logOne(emptyRoot, 'Bash', 'ls');
        const emptyLine = fs.readFileSync(path.join(emptyRoot, LOG_REL), 'utf8');
        if (previous === undefined) delete process.env[CLAUDE_PROJECT_DIR_ENV];
        else process.env[CLAUDE_PROJECT_DIR_ENV] = previous;

        expect(unsetLine).toContain(`\tprojectDir=${CLAUDE_PROJECT_DIR_UNSET}`);
        // Delimited by TABS, not anchored to end-of-line: an empty value must read as empty wherever
        // projectDir sits in the line, and it stopped being the last field when `tree=` was appended.
        expect(emptyLine).toContain('\tprojectDir=\t');
        expect(emptyLine).not.toContain(CLAUDE_PROJECT_DIR_UNSET);
    });
});

// logGuardDecision backs the blocked-Bash audit (hook-core.ts handleBash) — previously a denied Bash
// left no trail. A BLOCK line must carry the tool, the command, and the reason ("blocked and why").
describe('logGuardDecision', () => {
    it('records a Bash BLOCK with its command and reason', () => {
        const root = tmpRoot();
        logGuardDecision(
            root,
            new GuardDecision('bash-guard', 'Bash', 'gh pr create -t x', 'dean/foo', 'BLOCK_AI_CURE', 'use pnpm wp-start-upsert-pr instead', '-', L0_FAULT_NONE, MATRIX_L2_UNROWED),
        );
        const content = fs.readFileSync(path.join(root, DECISION_LOG_REL), 'utf8');
        expect(content).toContain('\tBLOCK_AI_CURE\t');
        expect(content).toContain('\tBash\t');
        expect(content).toContain('gh pr create');
        expect(content).toContain('use pnpm wp-start-upsert-pr instead');
        expect(content.trim().split('\n').length).toBe(1);
    });

    it('carries the same root / CLAUDE_PROJECT_DIR pair as the invocation stream', () => {
        const root = tmpRoot();
        logGuardDecision(root, new GuardDecision('bash-guard', 'Bash', 'ls', 'dean/foo', 'ALLOW', 'ok', '-', L0_FAULT_NONE, MATRIX_L2_UNROWED));
        const content = fs.readFileSync(path.join(root, DECISION_LOG_REL), 'utf8');
        expect(content).toContain(`\troot=${root}\t`);
        expect(content).toContain('\tprojectDir=');
    });
});
