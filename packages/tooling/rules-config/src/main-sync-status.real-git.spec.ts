import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { MainSyncStatusService } from '@webpieces/repo-workflow-core';

/**
 * The ONE real-git contract of the main-sync refresh (#1381). The refresher asks git for
 * `fetch --no-write-fetch-head` (asserted against scripted git in `main-sync-status.spec.ts`); what
 * scripted git cannot prove is the property that flag exists for — that the installed git really leaves
 * a foreground fetch's `.git/FETCH_HEAD` alone. So this runs the production service, with the
 * production git client, against a repo with a real (local path) `origin`.
 *
 * THE bug: the DETACHED refresher's `git fetch` used to rewrite `.git/FETCH_HEAD` while the agent was
 * running its own foreground fetch/pull in the same repo. The two unlocked writers could interleave into
 * a duplicate `for-merge` line, and `git pull` then died with "Cannot fast-forward to multiple branches"
 * — killing the very command the guards prescribe.
 */

function git(repo: string, cmd: string): void {
    execSync(`git ${cmd}`, { cwd: repo, stdio: 'pipe' });
}

// Does this git understand `--no-write-fetch-head` (2.29+)? On an older git the refresher knowingly
// falls back to the plain form, so the FETCH_HEAD assertion below does not apply.
function gitSupportsNoWriteFetchHead(): boolean {
    const probe = spawnSync('git', ['fetch', '--no-write-fetch-head', '--help'], { encoding: 'utf8' });
    return !(probe.stderr ?? '').toLowerCase().includes('unknown option');
}

function buildRepoWithRemote(origin: string, work: string): void {
    const steps = [
        'set -e',
        `git init -q --bare -b main ${origin}`,
        `git init -q ${work}`,
        `cd ${work}`,
        'git config core.hooksPath /dev/null',
        'git config user.email t@t.t',
        'git config user.name t',
        'git config commit.gpgsign false',
        "printf 'base\\n' > shared.txt",
        'git add -A',
        'git commit -q -m base',
        'git branch -M main',
        `git remote add origin ${origin}`,
        'git push -q origin main',
        'git checkout -q -b feature',
    ];
    execSync(steps.join('\n'), { shell: '/bin/sh', stdio: 'pipe' });
}

// `gh` answers "no PR" instantly from a stub on PATH, so this test neither needs gh nor its latency.
function stubGhOnPath(binDir: string): string {
    fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const previous = process.env['PATH'] ?? '';
    process.env['PATH'] = `${binDir}${path.delimiter}${previous}`;
    return previous;
}

describe('computeMainSyncStatus — must not write .git/FETCH_HEAD', () => {
    let origin: string;
    let work: string;
    let bin: string;
    let pathBefore = '';

    beforeEach(() => {
        origin = specTempDirs.make('mss-origin-');
        work = specTempDirs.make('mss-fh-');
        bin = specTempDirs.make('mss-bin-');
        fs.rmSync(work, { recursive: true, force: true });  // git init makes it
        buildRepoWithRemote(origin, work);
        pathBefore = stubGhOnPath(bin);
    });

    afterEach(() => {
        process.env['PATH'] = pathBefore;
        for (const dir of [origin, work, bin]) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('leaves a foreground fetch\'s FETCH_HEAD byte-for-byte untouched', async () => {
        if (!gitSupportsNoWriteFetchHead()) return;
        // Stand in for the agent's foreground `git fetch origin main`: one for-merge line.
        git(work, 'fetch origin main');
        const fetchHead = path.join(work, '.git', 'FETCH_HEAD');
        const before = fs.readFileSync(fetchHead, 'utf8');
        expect(before.split('\n').filter((l: string): boolean => l.trim().length > 0)).toHaveLength(1);

        await new MainSyncStatusService().computeMainSyncStatus(work);

        expect(fs.readFileSync(fetchHead, 'utf8')).toBe(before);
    });
});
