import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DotWebpieces, WORKTREE_STATE_DIR } from '@webpieces/rules-config';

import { renderShim, SHIM_LOG_MAX_BYTES, SHIM_LOG_FAULTS, SHIM_LOG_VERDICTS, RESOLVE_LOG_DIR_SH } from './shim';
import { L0_FAULTS, L0Fault } from '../core/l0-matrix';
import { ShimTestkit } from './shim-testkit';
import { L0_SHIM_STREAM } from '../core/log-streams';

const kit = new ShimTestkit();

// core.hooksPath=/dev/null: keep any machine-global git hooks out of the throwaway test repos.
function git(cwd: string, cmd: string): string {
    return execSync(`git -c core.hooksPath=/dev/null ${cmd}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/**
 * A real repo with a real linked worktree. Real git, not a mock, for the same reason state-dir.spec.ts
 * uses one: the whole question ("am I in a linked worktree, and what is git's name for it?") is
 * answered by git, so a mock would only prove the mock returns what it was told.
 *
 * realpathSync because macOS os.tmpdir() is a symlink and git reports the resolved path.
 */
export class TwoTreeRepo {
    readonly primary: string;
    readonly worktree: string;
    private readonly tmp: string;

    constructor(worktreeDirName: string) {
        this.tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-shimlog-')));
        this.primary = path.join(this.tmp, 'primary');
        this.worktree = path.join(this.tmp, worktreeDirName);
        fs.mkdirSync(this.primary, { recursive: true });
        git(this.primary, 'init -q -b main');
        git(this.primary, 'config user.email test@example.com');
        git(this.primary, 'config user.name Test');
        fs.writeFileSync(path.join(this.primary, 'webpieces.config.json'), '{}\n');
        git(this.primary, 'add -A');
        git(this.primary, 'commit -q -m init');
        git(this.primary, `worktree add -q -b feature ${this.worktree}`);
    }

    cleanup(): void {
        fs.rmSync(this.tmp, { recursive: true, force: true });
    }
}

/**
 * Drive the sh derivation ALONE, through a real /bin/sh: source RESOLVE_LOG_DIR_SH, call it with
 * `WP_CWD` set, print what it decided. This is the twin-lock harness — the same shape as
 * shim-drift.spec.ts's expectEngineTwins, but for the state-dir derivation rather than an allowlist.
 */
function shResolve(cwd: string): ShTree {
    const script = `WP_CWD="$1"\n${RESOLVE_LOG_DIR_SH}\nwp_resolve_log_dir\nprintf '%s\\n%s\\n' "$WP_TREE" "$WP_LOG_DIR"\n`;
    const run = spawnSync('/bin/sh', ['-c', script, 'sh', cwd], { encoding: 'utf8' });
    const lines = (run.stdout ?? '').split('\n');
    return new ShTree(lines[0] ?? '', lines[1] ?? '');
}

/** What the sh twin answered. Data-only → a class, per CLAUDE.md. */
export class ShTree {
    constructor(public readonly tree: string, public readonly logDir: string) {}
}

/**
 * sh CANNOT import TypeScript, so the worktree-name derivation is duplicated between
 * RESOLVE_LOG_DIR_SH and DotWebpieces. Duplication is unavoidable; THIS is the mitigation. If the two
 * ever answer differently, the logs quietly split in half — half of a worktree's L0 history in one
 * directory and half in another — with nothing to notice it. So the lock is here, driving the real sh.
 */
describe('sh ↔ TS twin: the worktree name and the state dir must be the SAME answer', () => {
    it('agrees with dotWebpieces.worktreeName()/logs() from a linked worktree AND from the primary', () => {
        const repo = new TwoTreeRepo('wt-feature');
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const dot = new DotWebpieces();

            const fromWorktree = shResolve(repo.worktree);
            expect(dot.worktreeName(repo.worktree)).toBe('wt-feature');
            expect(fromWorktree.tree).toBe(dot.worktreeName(repo.worktree));
            expect(fromWorktree.logDir).toBe(path.join(repo.primary, '.webpieces', WORKTREE_STATE_DIR, 'wt-feature', 'logs'));
            expect(fromWorktree.logDir).toBe(dot.logs(repo.worktree));

            const fromPrimary = shResolve(repo.primary);
            // TS spells "not a worktree" as an empty name; sh spells it `primary` because the value is
            // going straight into a log field where an empty column would read as a missing value.
            expect(dot.worktreeName(repo.primary)).toBe('');
            expect(fromPrimary.tree).toBe('primary');
            expect(fromPrimary.logDir).toBe(dot.logs(repo.primary));
        } finally {
            repo.cleanup();
        }
    });

    it('agrees when asked from a SUBDIRECTORY of each tree, not just its root', () => {
        const repo = new TwoTreeRepo('wt-feature');
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const dot = new DotWebpieces();
            const deep = path.join(repo.worktree, 'packages', 'deep');
            fs.mkdirSync(deep, { recursive: true });
            expect(shResolve(deep).logDir).toBe(dot.logs(deep));
            expect(shResolve(deep).tree).toBe(dot.worktreeName(deep));
        } finally {
            repo.cleanup();
        }
    });

    it('fails SOFT to <cwd>/.webpieces/logs when the directory is not a git repo at all', () => {
        const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-nogit-')));
        const answer = shResolve(plain);
        expect(answer.tree).toBe('primary');
        expect(answer.logDir).toBe(path.join(plain, '.webpieces', 'logs'));
    });
});

// A payload carrying the `cwd` field Claude Code documents — the field that decides which tree's log
// directory a line belongs in.
function bashPayloadFrom(cwd: string, command: string): string {
    return JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } });
}

// The log name now carries the stream prefix (<session|unknown>-<agent|coordinator>-<binName>-),
// so specs LOCATE the stream rather than hard-coding a name. Finding exactly one file also asserts
// the split did not accidentally fan a single writer across several.
function readLog(logDir: string): string {
    // `logDir` is the tree's `logs/`; the L0 line lives one level in, under its layer directory.
    const streamDir = path.join(logDir, L0_SHIM_STREAM);
    // `.1.log` also ends in `.log` — the LIVE writer is the one that does not.
    const hits = fs.readdirSync(streamDir).filter((n: string): boolean => n.endsWith('.log') && !n.endsWith('.1.log'));
    if (hits.length !== 1) throw new Error(`expected 1 shim log, found ${hits.length}: ${hits.join()}`);
    return fs.readFileSync(path.join(streamDir, hits[0]), 'utf8');
}

// Give `root` a guard bin that behaves however the test needs: exit 0 (allow), 2 (block), or 1 (crash).
function installBin(root: string, exitCode: number): void {
    const binDir = path.join(root, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'wp-ai-guards-hook'), `#!/bin/sh\nprintf EXECED\nexit ${String(exitCode)}\n`, { mode: 0o755 });
}

/**
 * WHERE the line lands. The shim used to hardcode `$ROOT/.webpieces/logs`, so every worktree's L0
 * history piled into one flat file while the L1 binary had been per-worktree since the state-dir
 * split. These assert the two halves finally agree.
 */
describe('L0 audit log routing — per worktree, centralized under the primary', () => {
    it('writes a call made in a LINKED WORKTREE under worktrees/<name>/logs/', () => {
        const repo = new TwoTreeRepo('wt-feature');
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            installBin(repo.worktree, 0);
            kit.runShim(repo.worktree, 'wp-ai-guards-hook', bashPayloadFrom(repo.worktree, 'pnpm build'));
            // Centralized in the PRIMARY on purpose: removing the worktree must not take its log with it.
            const logDir = path.join(repo.primary, '.webpieces', WORKTREE_STATE_DIR, 'wt-feature', 'logs');
            expect(readLog(logDir)).toContain('tree=wt-feature');
            expect(fs.existsSync(path.join(repo.worktree, '.webpieces', 'logs'))).toBe(false);
        } finally {
            repo.cleanup();
        }
    });

    it('writes a call made in the PRIMARY clone under .webpieces/logs/, with no namespace', () => {
        const repo = new TwoTreeRepo('wt-feature');
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            installBin(repo.primary, 0);
            kit.runShim(repo.primary, 'wp-ai-guards-hook', bashPayloadFrom(repo.primary, 'pnpm build'));
            expect(readLog(path.join(repo.primary, '.webpieces', 'logs'))).toContain('tree=primary');
        } finally {
            repo.cleanup();
        }
    });

    it('routes by the PAYLOAD cwd, so a shim invoked for one tree never logs into another', () => {
        const repo = new TwoTreeRepo('wt-feature');
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // The shim FILE lives in the primary (that is how CLAUDE_PROJECT_DIR-anchored invocation
            // works today) while the call itself is made in the worktree. The line belongs to the tree
            // the CALL was in — otherwise a worktree's whole L0 history lands in the primary's file.
            installBin(repo.primary, 0);
            kit.runShim(repo.primary, 'wp-ai-guards-hook', bashPayloadFrom(repo.worktree, 'pnpm build'));
            const logDir = path.join(repo.primary, '.webpieces', WORKTREE_STATE_DIR, 'wt-feature', 'logs');
            expect(readLog(logDir)).toContain('tree=wt-feature');
            expect(fs.existsSync(path.join(repo.primary, '.webpieces', 'logs', L0_SHIM_STREAM))).toBe(false);
        } finally {
            repo.cleanup();
        }
    });
});

// Stage a root whose package.json pin and installed version disagree — the D fault. Same shape as
// stageDriftRoot in shim-drift.spec.ts.
function stageDriftRoot(declared: string, installed: string): string {
    const root = kit.mktmp();
    installBin(root, 0);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@webpieces/pr-gate': declared } }) + '\n');
    const manifestDir = path.join(root, 'node_modules', '@webpieces', 'pr-gate');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'package.json'), JSON.stringify({ version: installed }) + '\n');
    return root;
}

function logOf(root: string): string {
    return readLog(path.join(root, '.webpieces', 'logs'));
}

/**
 * AUDIT COMPLETENESS. Before this change `wp_log` fired ONLY on the fail-closed path — a healthy call
 * exec'd the bin and recorded nothing — so "no line" meant either "fine" or "the shim never ran", the
 * two answers a reader most needs to tell apart. This is the behaviour change, and it is the test that
 * fails against the old shim and passes against the new one.
 */
describe('L0 audit log completeness — the HEALTHY call is logged too', () => {
    it('logs PASS-BIN-ALLOW with no fault when the bin runs and allows', () => {
        const root = kit.mktmp();
        installBin(root, 0);
        const out = kit.runShim(root, 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        expect(out.stdout).toBe('EXECED');     // the guards really did run; this is the healthy path
        expect(logOf(root)).toContain('\tfault=-\tPASS-BIN-ALLOW\tpnpm build');
    });

    it('logs PASS-BIN-BLOCK when the bin runs and returns a block (exit 2)', () => {
        const root = kit.mktmp();
        installBin(root, 2);
        expect(kit.runShim(root, 'wp-ai-guards-hook', kit.bashPayload('git push')).status).toBe(2);
        expect(logOf(root)).toContain('\tfault=-\tPASS-BIN-BLOCK\tgit push');
    });

    it('records the tool and the bin name on every line, healthy or not', () => {
        const root = kit.mktmp();
        installBin(root, 0);
        kit.runShim(root, 'wp-ai-guards-hook', kit.readPayload('/x/design.json'));
        expect(logOf(root)).toContain('\twp-ai-guards-hook\tRead\t');
    });
});

/**
 * FAULT CLASSIFICATION, in guards/L0-tooling.md's own letters. The shim can only classify the three
 * sh-side faults (D/X/K); S/C/Y are the binary's, which on these paths never ran.
 */
describe('L0 audit log — the fault field matches guards/L0-tooling.md', () => {
    it('classifies version drift as fault D (verdict DENY-STALE)', () => {
        const root = stageDriftRoot('0.3.272', '0.3.270');
        kit.runShim(root, 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        expect(logOf(root)).toContain('\tfault=D\tDENY-STALE\tpnpm build');
    });

    it('classifies a MISSING bin as fault X (verdict DENY)', () => {
        // DECLARED but not installed — the fresh-clone case. The declaration is what separates X from U,
        // so it has to be staged rather than assumed: a bare mktmp() root is fault U.
        const root = kit.stageDeclaredRoot();   // package.json asks for it; no node_modules/.bin at all
        kit.runShim(root, 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        expect(logOf(root)).toContain('\tfault=X\tDENY\tpnpm build');
    });

    it('classifies a MISSING bin that nothing DECLARES as fault U (verdict DENY-UNDECLARED)', () => {
        const root = kit.mktmp();   // no package.json at all → nothing asks for the package
        kit.runShim(root, 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        expect(logOf(root)).toContain('\tfault=U\tDENY-UNDECLARED\tpnpm build');
    });

    it('classifies a CRASHED bin as fault K (verdict DENY-BROKEN)', () => {
        const root = kit.mktmp();
        installBin(root, 1);        // exit 1 = neither a decision nor an allow → the guard crashed
        kit.runShim(root, 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        expect(logOf(root)).toContain('\tfault=K\tDENY-BROKEN\tpnpm build');
    });

    it('carries the fault alongside an ALLOWED cure, so a recovery is auditable too', () => {
        const root = stageDriftRoot('0.3.272', '0.3.270');
        kit.runShim(root, 'wp-ai-guards-hook', kit.bashPayload('pnpm install'));
        expect(logOf(root)).toContain('\tfault=D\tALLOW-CURE\tpnpm install');
    });

    it('logs an allowed Read and an allowed config edit while the guards are down', () => {
        const root = kit.stageDeclaredRoot();
        kit.runShim(root, 'wp-ai-guards-hook', kit.readPayload('/x/README.md'));
        kit.runShim(root, 'wp-ai-guards-hook', kit.filePayload('Edit', '/x/webpieces.config.json'));
        const log = logOf(root);
        expect(log).toContain('\tfault=X\tALLOW-READ\t');
        expect(log).toContain('\tfault=X\tALLOW-CONFIG\t');
    });
});

/**
 * ROTATION. The shim runs on EVERY tool call and now logs every one of them, so an unbounded file is
 * not a theoretical concern. Same 512 KB threshold and the same `.1.log` sibling as decision-log.ts —
 * two log families in one directory with two retention rules would be a trap.
 */
describe('L0 audit log rotation — 512 KB into a .1.log sibling', () => {
    it('rotates once the log exceeds the cap, and keeps writing to the live file', () => {
        const root = kit.mktmp();
        installBin(root, 0);
        const logDir = path.join(root, '.webpieces', 'logs');
        // Seed the writer the shim will actually append to, inside its LAYER directory.
        fs.mkdirSync(path.join(logDir, L0_SHIM_STREAM), { recursive: true });
        const stream = path.join(L0_SHIM_STREAM, 'unknown-coordinator-wp-ai-guards-hook.log');
        fs.writeFileSync(path.join(logDir, stream), 'x'.repeat(SHIM_LOG_MAX_BYTES + 10));

        kit.runShim(root, 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));

        // The sibling keeps the identical writer key, so rotation stays within one stream.
        const prev = path.join(L0_SHIM_STREAM, 'unknown-coordinator-wp-ai-guards-hook.1.log');
        expect(fs.existsSync(path.join(logDir, prev))).toBe(true);
        const live = readLog(logDir);
        expect(live).toContain('PASS-BIN-ALLOW');
        expect(live.length).toBeLessThan(SHIM_LOG_MAX_BYTES); // the old bytes went to the sibling
    });

    it('does NOT rotate a log still under the cap', () => {
        const root = kit.mktmp();
        installBin(root, 0);
        const logDir = path.join(root, '.webpieces', 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        fs.mkdirSync(path.join(logDir, L0_SHIM_STREAM), { recursive: true });
        fs.writeFileSync(path.join(logDir, L0_SHIM_STREAM, 'unknown-coordinator-wp-ai-guards-hook.log'), 'x'.repeat(1024));
        kit.runShim(root, 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        expect(fs.existsSync(path.join(logDir, L0_SHIM_STREAM, 'unknown-coordinator-wp-ai-guards-hook.1.log'))).toBe(false);
    });
});

/**
 * LOGGING MUST NEVER BLOCK OR FAIL A HOOK. This is the property that lets the log be written on the
 * blocking path of every tool call at all: if it cannot write, the call proceeds exactly as it would
 * have, and nothing reaches stdout — stdout is the PreToolUse decision channel and one stray byte
 * there corrupts allow/deny.
 */
describe('L0 audit log is best-effort — an unwritable log dir changes nothing', () => {
    it('still execs the bin and returns its verdict when the log directory cannot be created', () => {
        const root = kit.mktmp();
        installBin(root, 0);
        // A FILE where the state dir must be: mkdir -p cannot succeed, at any depth beneath it.
        fs.writeFileSync(path.join(root, '.webpieces'), 'not a directory\n');

        const out = kit.runShim(root, 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));

        expect(out.stdout).toBe('EXECED');   // exactly the healthy result, with no logging noise added
        expect(out.status).toBe(0);
        expect(out.stderr).toBe('');
    });

    it('still DENIES (fails closed) when the guards are down and the log cannot be written', () => {
        const root = kit.stageDeclaredRoot();  // declared but no bin → fault X
        fs.writeFileSync(path.join(root, '.webpieces'), 'not a directory\n');
        const out = kit.runShim(root, 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        expect(out.isDenied()).toBe(true);
        expect(out.denyReason()).toContain('not installed');
    });
});

/**
 * THE LINE FORMAT itself — 9 tab-separated fields. Locked because the whole point of this log is that
 * a human or an agent can reconcile it against guards/L0-tooling.md, and a format nobody agreed on cannot
 * be reconciled against anything.
 *
 * `shim=` and `bin=` were added between `tree=` and `fault=`, deliberately breaking any positional
 * reader rather than appending where a stale parser would silently keep working. They are the two facts
 * the log could not previously answer: WHICH COPY of ai-hook.sh ran (both `.claude/webpieces/*.sh` are
 * tracked, so each worktree carries its own at its own commit, and settings.json registers them
 * RELATIVE) and WHICH TREE supplied the binary (a fresh linked worktree has no node_modules, so the
 * upward walk normally borrows the primary's). Before them, "which hook governed this call" was only
 * answerable by inference.
 */
describe('L0 audit log line format', () => {
    it('emits exactly ts, bin, tool, tree=, shim=, bin=, fault=, verdict, command — tab separated', () => {
        const root = kit.mktmp();
        installBin(root, 0);
        kit.runShim(root, 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        const fields = logOf(root).trim().split('\t');
        expect(fields).toHaveLength(9);
        expect(fields[1]).toBe('wp-ai-guards-hook');
        expect(fields[2]).toBe('Bash');
        expect(fields[3].startsWith('tree=')).toBe(true);
        expect(fields[4].startsWith('shim=')).toBe(true);
        expect(fields[5].startsWith('bin=')).toBe(true);
        expect(fields[6].startsWith('fault=')).toBe(true);
        expect(fields[7]).toBe('PASS-BIN-ALLOW');
        expect(fields[8]).toBe('pnpm build');
    });

    /**
     * The two new fields must carry REAL paths, not empty strings — an empty `shim=` would read as "we
     * do not know which copy ran", which is the state this change exists to end. In a plain root with
     * its own node_modules the two agree; the borrow case (they differ) is what a linked worktree shows.
     */
    it('shim= and bin= name real trees, and agree when the tree has its own node_modules', () => {
        const root = kit.mktmp();
        installBin(root, 0);
        kit.runShim(root, 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        const fields = logOf(root).trim().split('\t');
        expect(fields[4]).toBe(`shim=${root}`);
        expect(fields[5]).toBe(`bin=${root}`);
    });

    // The verdict stays immediately before the command, so the greps that predate the tree/fault
    // fields — `grep 'DENY-STALE\t'` — still find what they always found.
    it('keeps the verdict adjacent to the command, as it has always been', () => {
        const root = stageDriftRoot('0.3.272', '0.3.270');
        kit.runShim(root, 'wp-ai-guards-hook', kit.bashPayload('pnpm build'));
        expect(logOf(root)).toContain('DENY-STALE\tpnpm build');
    });

    it('renders the log path from the shared state-dir constants, never a hardcoded hooks/', () => {
        const shim = renderShim();
        expect(shim).toContain('/.webpieces/worktrees/$WP_TREE/logs');
        expect(shim).not.toContain('.webpieces/hooks');
    });
});

/**
 * THE VOCABULARY LOCK. The whole point of the `fault=` field is that the log can be reconciled
 * against the L0 matrix, and that only works while the shim's letters and the matrix's letters are the
 * same letters. Prose in two files cannot enforce that; this can. `L0_FAULTS` is the array the doc is
 * GENERATED from, so it is the authority — if the two ever diverge, this is what says so.
 */
describe('the log vocabulary is the matrix vocabulary', () => {
    it('emits exactly the sh-side fault codes L0_FAULTS declares, plus `-` for no fault', () => {
        const shSide = L0_FAULTS.filter((fault: L0Fault): boolean => fault.enforcedIn === 'sh')
            .map((fault: L0Fault): string => fault.code);
        expect(shSide).toEqual(['D', 'X', 'U', 'K']);
        expect([...SHIM_LOG_FAULTS]).toEqual([...shSide, '-']);
    });

    it('renders every declared fault code, and only those, into the shim', () => {
        const shim = renderShim();
        for (const code of ['D', 'X', 'K']) {
            expect(shim, `fault ${code} is never assigned in the shim`).toContain(`WP_FAULT=${code}`);
        }
        // S/C/Y belong to the binary; the shim must not claim to classify them.
        for (const code of ['S', 'C', 'Y']) {
            expect(shim).not.toContain(`WP_FAULT=${code}`);
        }
    });

    it('emits only verdicts the documented table names', () => {
        const shim = renderShim();
        for (const verdict of SHIM_LOG_VERDICTS) {
            expect(shim, `verdict ${verdict} is never emitted`).toContain(verdict);
        }
    });
});
