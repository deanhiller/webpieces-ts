import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    MERGE_BODY_FILE, MachineStateHome, PR_ORIGIN_FILE, PrBodyStore, WEBPIECES_STATE_HOME_ENV,
} from '@webpieces/rules-config';

import { MergeBodyFiler, MergeBodyRequest } from './merge-body-filer';

/**
 * The WRITE half of the finish→land contract: `wp-finish-upsert-pr` must leave the gated squash body
 * somewhere a `wp-land-pr` in ANOTHER tree can find it. Real git repo, real remote, real temp state
 * home — the claim is entirely about where bytes land, so nothing here is mocked.
 */

let tmp = '';
let stateHome = '';
let repo = '';
let stderr = '';
const savedOverride = process.env[WEBPIECES_STATE_HOME_ENV];

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function request(): MergeBodyRequest {
    const req = new MergeBodyRequest();
    req.treeRoot = repo;
    req.branch = 'dean/feature';
    req.feature = 'dean-feature';
    req.prNumber = '604';
    req.prUrl = 'https://github.com/acme/widgets/pull/604';
    req.body = 'risk: 🟢 green\nflags: none\n';
    return req;
}

// Runs the filer with stdout/stderr captured, so the degraded WARNING is asserted rather than assumed.
function fileIt(req: MergeBodyRequest): string {
    const outWrite = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    stderr = '';
    // webpieces-disable no-any-unknown -- stubbing node's write signature for the duration of one call
    process.stdout.write = ((): boolean => true) as unknown as typeof process.stdout.write;
    // webpieces-disable no-any-unknown -- stubbing node's write signature for the duration of one call
    process.stderr.write = ((chunk: string): boolean => {
        stderr += chunk;
        return true;
    }) as unknown as typeof process.stderr.write;
    // webpieces-disable no-unmanaged-exceptions -- chokepoint: the streams must be restored whatever happens
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return new MergeBodyFiler(new PrBodyStore(new MachineStateHome())).file(req);
    } finally {
        process.stdout.write = outWrite;
        process.stderr.write = errWrite;
    }
}

beforeEach((): void => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-body-filer-'));
    stateHome = path.join(tmp, 'state');
    process.env[WEBPIECES_STATE_HOME_ENV] = stateHome;
    repo = path.join(tmp, 'clone');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    // This developer's global hooks refuse commits to main; a temp repo must opt out of them.
    git(repo, 'config', 'core.hooksPath', '/dev/null');
    git(repo, 'config', 'user.email', 'spec@example.com');
    git(repo, 'config', 'user.name', 'spec');
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
    fs.writeFileSync(path.join(repo, 'README.md'), '# spec\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
});

afterEach((): void => {
    if (savedOverride === undefined) delete process.env[WEBPIECES_STATE_HOME_ENV];
    else process.env[WEBPIECES_STATE_HOME_ENV] = savedOverride;
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('MergeBodyFiler — finish files the gated body machine-globally', () => {
    it('writes it under the PR global identity, NOT under the tree that rendered it', (): void => {
        const req = request();
        const written = fileIt(req);

        expect(written).toBe(path.join(stateHome, 'prs', 'github.com', 'acme', 'widgets', '604', MERGE_BODY_FILE));
        expect(fs.readFileSync(written, 'utf8')).toBe(req.body);
        // The hard cut: the old per-worktree home is NOT written as well. Two homes for one receipt is
        // two answers to "which bytes land", and the stale one wins exactly when the trees differ.
        expect(fs.existsSync(path.join(repo, '.webpieces', 'pr-review', 'dean-feature', MERGE_BODY_FILE))).toBe(false);
    });

    it('records the provenance land needs to decide whose bookkeeping this is', (): void => {
        fileIt(request());
        const originFile = path.join(stateHome, 'prs', 'github.com', 'acme', 'widgets', '604', PR_ORIGIN_FILE);
        // webpieces-disable no-any-unknown -- reading back the sidecar this spec just wrote
        const origin = JSON.parse(fs.readFileSync(originFile, 'utf8')) as Record<string, unknown>;
        expect(origin['treeRoot']).toBe(repo);
        expect(origin['branch']).toBe('dean/feature');
        expect(origin['prNumber']).toBe('604');
    });

    it('falls back to a TEMP file — and says landing will not find it — when the PR number is unknown', (): void => {
        const req = request();
        req.prNumber = '';

        const written = fileIt(req);

        expect(written.startsWith(stateHome)).toBe(false);
        expect(fs.readFileSync(written, 'utf8')).toBe(req.body);
        expect(stderr).toContain('not found on this machine');
    });

    it('WARNS loudly when the state home degraded into the clone', (): void => {
        const blocker = path.join(tmp, 'a-file');
        fs.writeFileSync(blocker, '');
        process.env[WEBPIECES_STATE_HOME_ENV] = path.join(blocker, 'nope');

        const written = fileIt(request());

        expect(written.startsWith(path.join(repo, '.webpieces'))).toBe(true);
        expect(stderr).toContain('INSIDE this clone');
        expect(stderr).toContain(WEBPIECES_STATE_HOME_ENV);
    });
});
