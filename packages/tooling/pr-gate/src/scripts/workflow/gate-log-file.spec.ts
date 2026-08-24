import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GateLogFile } from './gate-log-file';

let tmp = '';
let primary = '';
let worktree = '';
let files: GateLogFile;

function git(cwd: string, args: string): void {
    execSync(`git ${args}`, { cwd, stdio: 'ignore' });
}

/**
 * A primary clone with ONE linked worktree, because that is the case the placement rule exists for: the
 * point of routing through `dotWebpieces` rather than `path.join(repoRoot, '.webpieces')` is that N
 * agents in N worktrees never write one another's log, and that a reaped worktree's history survives.
 */
beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-gatelog-')));
    primary = path.join(tmp, 'primary');
    worktree = path.join(tmp, 'wt-feature');
    fs.mkdirSync(primary, { recursive: true });
    git(primary, 'init -q -b main');
    git(primary, 'config core.hooksPath /dev/null');
    git(primary, 'config user.email test@example.com');
    git(primary, 'config user.name Test');
    fs.writeFileSync(path.join(primary, 'README.md'), '# spec\n');
    git(primary, 'add -A');
    git(primary, 'commit -q -m init');
    git(primary, `worktree add -q -b feature ${worktree}`);
    files = new GateLogFile();
});

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('GateLogFile placement', () => {
    it('puts a logs/ file under the primary clone in the primary clone', () => {
        expect(files.logsPath(primary, 'stage.log')).toBe(path.join(primary, '.webpieces', 'logs', 'stage.log'));
    });

    it('puts a root file at the top of the state dir — the one path a person types from memory', () => {
        expect(files.localPath(primary, 'build.log')).toBe(path.join(primary, '.webpieces', 'build.log'));
    });

    /**
     * THE placement rule. A linked worktree's log lands under the PRIMARY clone, namespaced by git's own
     * worktree name — never inside the worktree. That is what makes the history outlive `wp-cleanup`
     * reaping the directory, and what makes concurrent agents safe by construction rather than by naming.
     */
    it('namespaces a linked worktree under the PRIMARY clone, not inside the worktree', () => {
        const log = files.logsPath(worktree, 'stage.log');
        expect(log).toBe(path.join(primary, '.webpieces', 'worktrees', 'wt-feature', 'logs', 'stage.log'));
        expect(log.startsWith(worktree + path.sep)).toBe(false);
    });

    it('resolves the same path from a SUBDIRECTORY of the worktree', () => {
        const deep = path.join(worktree, 'packages', 'deep');
        fs.mkdirSync(deep, { recursive: true });
        expect(files.logsPath(deep, 'stage.log')).toBe(files.logsPath(worktree, 'stage.log'));
    });

    it('gives two worktrees DISJOINT logs of the same name', () => {
        const second = path.join(tmp, 'wt-other');
        git(primary, `worktree add -q -b other ${second}`);
        expect(files.logsPath(worktree, 'stage.log')).not.toBe(files.logsPath(second, 'stage.log'));
    });

    it('creates the directory, so a caller can open the path it was handed', () => {
        expect(fs.existsSync(path.dirname(files.logsPath(worktree, 'stage.log')))).toBe(true);
    });
});

/** ONE previous generation, so the last TWO runs are always on disk and the filename can stay fixed. */
describe('GateLogFile rotation', () => {
    it('moves an existing log to <log>.bak before the next run writes', () => {
        const p = files.logsPath(primary, 'stage.log');
        fs.writeFileSync(p, 'first-run\n');
        files.rotate(p);
        expect(fs.existsSync(p)).toBe(false);
        expect(fs.readFileSync(files.backupPathFor(p), 'utf8')).toContain('first-run');
    });

    it('keeps exactly one generation — a third run overwrites the .bak rather than failing', () => {
        const p = files.logsPath(primary, 'stage.log');
        fs.writeFileSync(files.backupPathFor(p), 'ancient\n');
        fs.writeFileSync(p, 'previous\n');
        files.rotate(p);
        expect(fs.readFileSync(files.backupPathFor(p), 'utf8')).toContain('previous');
        expect(fs.existsSync(`${files.backupPathFor(p)}.bak`)).toBe(false);
    });

    // The first run in a fresh clone has nothing to rotate, and that is not a failure.
    it('is a no-op when there is no previous log', () => {
        const p = files.logsPath(primary, 'stage.log');
        files.rotate(p);
        expect(fs.existsSync(files.backupPathFor(p))).toBe(false);
    });
});

describe('GateLogFile pointer', () => {
    it('names the log and says the previous run is beside it, once one exists', () => {
        const p = files.logsPath(primary, 'stage.log');
        fs.writeFileSync(p, 'run\n');
        files.rotate(p);
        fs.writeFileSync(p, 'run2\n');
        const pointer = files.pointer(p);
        expect(pointer).toContain(`FullLog : ${p}`);
        expect(pointer).toContain('stage.log is backed up to stage.log.bak every run');
    });

    // Pointing a reader at a file that does not exist is the small lie that costs a wasted `cat`.
    it('does not claim a backup on the very first run', () => {
        const p = files.logsPath(primary, 'stage.log');
        fs.writeFileSync(p, 'run\n');
        expect(files.pointer(p)).toContain('this is the first, so there is none yet');
    });
});

describe('GateLogFile reading', () => {
    it('counts lines, and reads a missing log as zero rather than throwing', () => {
        const p = files.logsPath(primary, 'stage.log');
        expect(files.lineCount(p)).toBe(0);
        fs.writeFileSync(p, 'a\nb\nc\n');
        expect(files.lineCount(p)).toBe(3);
    });

    it('tails the last N lines, indented', () => {
        const p = files.logsPath(primary, 'stage.log');
        fs.writeFileSync(p, Array.from({ length: 50 }, (_v: unknown, i: number): string => `line-${String(i)}`).join('\n'));
        const tail = files.tail(p, 3);
        expect(tail).toContain('    line-49');
        expect(tail).not.toContain('line-46');
    });

    /**
     * This renders a message for something that has ALREADY failed, so an I/O error escaping here would
     * replace the real failure with the renderer's own.
     */
    it('reports an unreadable log rather than throwing over it', () => {
        const p = files.logsPath(primary, 'stage.log');
        fs.mkdirSync(p);  // exists, but readFileSync cannot read a directory
        expect(files.tail(p, 5)).toContain(`could not read ${p}`);
    });

    it('says so when there is no log at all', () => {
        expect(files.tail('/abs/nope.log', 5)).toContain('(no log file at /abs/nope.log)');
    });
});
