import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { MachineStateHome, WEBPIECES_STATE_HOME_ENV } from './machine-state-home';
import { MERGE_BODY_FILE, PR_ORIGIN_FILE, PrBodyOrigin, PrBodyStore } from './pr-body-store';

/**
 * REAL git repositories with REAL remotes, and a real temp state home. The whole claim being tested is
 * "a body written from one tree is found from another tree, and from a second clone of the same repo",
 * and that claim is about `git remote get-url` and the filesystem — mocking either would test nothing.
 */

let tmp = '';
let stateHome = '';
const savedOverride = process.env[WEBPIECES_STATE_HOME_ENV];

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// A repo with one commit, one branch, and `origin` pointing at `remoteUrl`. `core.hooksPath=/dev/null`
// because this developer's global pre-push/pre-commit hooks refuse commits to main.
function repoWithRemote(name: string, remoteUrl: string): string {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'core.hooksPath', '/dev/null');
    git(dir, 'config', 'user.email', 'spec@example.com');
    git(dir, 'config', 'user.name', 'spec');
    git(dir, 'remote', 'add', 'origin', remoteUrl);
    fs.writeFileSync(path.join(dir, 'README.md'), '# spec\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    return dir;
}

function store(): PrBodyStore {
    // A fresh MachineStateHome (and therefore a fresh cache) per store, so each test's env var is read.
    return new PrBodyStore(new MachineStateHome());
}

beforeEach((): void => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-pr-body-'));
    stateHome = path.join(tmp, 'state');
    process.env[WEBPIECES_STATE_HOME_ENV] = stateHome;
});

afterEach((): void => {
    if (savedOverride === undefined) delete process.env[WEBPIECES_STATE_HOME_ENV];
    else process.env[WEBPIECES_STATE_HOME_ENV] = savedOverride;
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('PrBodyStore — the remote slug', () => {
    // One table, because the ONLY thing that matters is that every shape git hands out lands on the
    // same three segments: a wrong key files the receipt under a repo the PR is not on, which reads to
    // the next reader as "the body was never written" — the exact failure being fixed.
    const cases: [string, string, string, string][] = [
        ['git@github.com:acme/widgets.git', 'github.com', 'acme', 'widgets'],
        ['git@github.com:acme/widgets', 'github.com', 'acme', 'widgets'],
        ['https://github.com/acme/widgets.git', 'github.com', 'acme', 'widgets'],
        ['https://token@github.com/acme/widgets.git', 'github.com', 'acme', 'widgets'],
        ['ssh://git@github.com:22/acme/widgets.git', 'github.com', 'acme', 'widgets'],
        ['https://gitlab.com/acme/team/sub/widgets.git', 'gitlab.com', 'acme/team/sub', 'widgets'],
    ];

    for (const [url, host, owner, repo] of cases) {
        it(`parses ${url}`, (): void => {
            const dir = repoWithRemote(`r-${host}-${owner}-${repo}-${url.length}`, url);
            const slug = store().slugFor(dir);
            expect([slug.host, slug.owner, slug.repo]).toEqual([host, owner, repo]);
            expect(slug.known).toBe(true);
        });
    }

    it('is UNKNOWN — never guessed — when there is no origin remote', (): void => {
        const dir = path.join(tmp, 'noremote');
        fs.mkdirSync(dir);
        git(dir, 'init', '-q', '-b', 'main');
        expect(store().slugFor(dir).known).toBe(false);
        expect(store().dirFor(dir, '7')).toBe('');
    });

    it('refuses to key a PR whose number is not a number', (): void => {
        const dir = repoWithRemote('numbers', 'git@github.com:acme/widgets.git');
        expect(store().dirFor(dir, '')).toBe('');
        expect(store().dirFor(dir, '../../escape')).toBe('');
    });
});

describe('PrBodyStore — write here, read from anywhere on this machine', () => {
    const REMOTE = 'git@github.com:acme/widgets.git';
    const BODY = 'risk: 🟢 green\nflags: none\nhttps://github.com/acme/widgets/pull/604\n';

    function origin(treeRoot: string): PrBodyOrigin {
        const o = new PrBodyOrigin();
        o.treeRoot = treeRoot;
        o.primaryRoot = treeRoot;
        o.branch = 'dean/feature';
        o.feature = 'feature';
        o.prNumber = '604';
        o.prUrl = 'https://github.com/acme/widgets/pull/604';
        o.writtenAt = new Date().toISOString();
        return o;
    }

    it('files the body under the PR global identity, nested host/owner/repo/number', (): void => {
        const primary = repoWithRemote('primary', REMOTE);
        const written = store().write(primary, '604', BODY, origin(primary));

        expect(written).not.toBeNull();
        expect(written?.bodyFile).toBe(
            path.join(stateHome, 'prs', 'github.com', 'acme', 'widgets', '604', MERGE_BODY_FILE));
        expect(fs.readFileSync(written?.bodyFile ?? '', 'utf8')).toBe(BODY);
        expect(fs.existsSync(path.join(written?.dir ?? '', PR_ORIGIN_FILE))).toBe(true);
    });

    // The incident: the gated flow ran in the primary clone, landing happened in a linked worktree.
    it('is readable from a LINKED WORKTREE of the same clone, with the origin tree preserved', (): void => {
        const primary = repoWithRemote('primary', REMOTE);
        store().write(primary, '604', BODY, origin(primary));

        const worktree = path.join(tmp, 'wt-a');
        git(primary, 'worktree', 'add', '-q', '-b', 'dean/feature', worktree);

        const read = store().read(worktree, '604');
        expect(fs.readFileSync(read?.bodyFile ?? '', 'utf8')).toBe(BODY);
        expect(read?.origin?.treeRoot).toBe(primary);
    });

    // The stronger claim, and the reason the key is the REMOTE and not the clone path: a SECOND CLONE of
    // the same repo resolves the same PR to the same bytes.
    it('is readable from a SECOND CLONE of the same repo on this machine', (): void => {
        const primary = repoWithRemote('primary', REMOTE);
        store().write(primary, '604', BODY, origin(primary));

        const second = repoWithRemote('second-clone', REMOTE);
        const read = store().read(second, '604');

        expect(read).not.toBeNull();
        expect(fs.readFileSync(read?.bodyFile ?? '', 'utf8')).toBe(BODY);
        // …and the provenance still names the tree that posted it, which is what lets wp-land-pr decline
        // the tree-bound bookkeeping instead of tagging the wrong commit here.
        expect(read?.origin?.treeRoot).toBe(primary);
        expect(path.resolve(read?.origin?.treeRoot ?? '')).not.toBe(path.resolve(second));
    });

    it('does NOT hand a DIFFERENT repo the same PR number', (): void => {
        const widgets = repoWithRemote('widgets', REMOTE);
        const gadgets = repoWithRemote('gadgets', 'git@github.com:acme/gadgets.git');
        store().write(widgets, '604', BODY, origin(widgets));

        expect(store().read(gadgets, '604')).toBeNull();
    });

    it('returns null (rather than inventing a key) when the remote is unknown', (): void => {
        const dir = path.join(tmp, 'bare');
        fs.mkdirSync(dir);
        git(dir, 'init', '-q', '-b', 'main');
        expect(store().write(dir, '604', BODY, origin(dir))).toBeNull();
    });

    it('degrades into the clone — without throwing — when the state home is unusable', (): void => {
        const blocker = path.join(tmp, 'file');
        fs.writeFileSync(blocker, '');
        process.env[WEBPIECES_STATE_HOME_ENV] = path.join(blocker, 'nope');
        const primary = repoWithRemote('degraded', REMOTE);

        const s = store();
        expect(s.home(primary).degraded).toBe(true);
        const written = s.write(primary, '604', BODY, origin(primary));
        expect(written?.bodyFile.startsWith(path.join(primary, '.webpieces'))).toBe(true);
        expect(fs.readFileSync(written?.bodyFile ?? '', 'utf8')).toBe(BODY);
    });
});
