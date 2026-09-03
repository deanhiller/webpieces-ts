import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BranchArchiver, InformAiError, RepoRootFinder, WorktreeService, toError } from '@webpieces/rules-config';

import { LandPrCommand, LandPrRequest } from './land-pr-command';
import { RepoConfigFixture } from '../workflow/repo-config-testkit';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { LandedTreeResolver } from '../workflow/landed-tree-resolver';
import { LandedWorktreeReaper } from '../workflow/landed-worktree-reaper';
import { MergeBodyTempFile } from '../workflow/merge-body-temp-file';
import { MergeInfoIndex } from '../workflow/merge-info-index';
import { MergeState } from '../workflow/merge-state';
import { PrMerger } from '../workflow/pr-merger';
import { ReapOutcomeSignal } from '../workflow/reap-outcome';

/**
 * The READ half of the finish→land contract, end to end through the real PrMerger.
 *
 * `gh` is a REAL executable on PATH — a shell script that logs every invocation and, for
 * `pr merge --body-file <f>`, copies the file's BYTES aside. That is the only assertion worth making
 * about this command: what exactly reached main's history. Nothing here touches the network, and no
 * merge is ever performed.
 *
 * ─── What changed, and why the old scenarios are gone ──────────────────────────────────────────────
 * The gated body used to be a file on THIS MACHINE (`~/.webpieces/prs/<host>/<owner>/<repo>/<n>/`), so
 * the interesting cases were all "which tree/clone/machine is looking". Since the PR DESCRIPTION became
 * the compact merge body, GitHub holds the bytes, and every one of those cases collapses into "ask the
 * PR". So the machine-global scenarios are DELETED rather than ported: they were tests of a store that
 * no longer exists. What survives is the invariant they protected — the bytes that land are the bytes
 * finish produced — plus the bookkeeping decision, which is now re-derived from `headRefOid`.
 */

const BRANCH = 'dean/feature';
const REMOTE = 'git@github.com:acme/widgets.git';
// What `wp-finish-upsert-pr` publishes as the PR description, verbatim. See dashboard.renderPrBody and
// pr-body-is-merge-body.spec.ts: this string IS both surfaces.
const PR_DESCRIPTION = 'https://github.com/acme/widgets/pull/604\n\nRisk: green\n\nSummary.\n';

let tmp = '';
let primary = '';
let ghLog = '';
let ghBodyCapture = '';
let savedCwd = '';
let prBody = PR_DESCRIPTION;
let prHeadOid = '';
const savedPath = process.env['PATH'];
const savedInitCwd = process.env['INIT_CWD'];

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * THIS repo's own webpieces.config.json, prepared for a temp clone by RepoConfigFixture — the real file
 * rather than a hand-rolled stub, so the spec exercises the same validator the tool really faces.
 */
function writeConfig(dir: string): void {
    const fixture = new RepoConfigFixture();
    fixture.writeTo(dir, fixture.load());
}

// A clone of "acme/widgets" with a main commit and the feature branch checked out.
function makeClone(name: string): string {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    // The global pre-push/pre-commit hooks on this machine refuse commits to main.
    git(dir, 'config', 'core.hooksPath', '/dev/null');
    git(dir, 'config', 'user.email', 'spec@example.com');
    git(dir, 'config', 'user.name', 'spec');
    git(dir, 'remote', 'add', 'origin', REMOTE);
    writeConfig(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    git(dir, 'checkout', '-q', '-b', BRANCH);
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'work\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'feature');
    return dir;
}

/**
 * A real `gh` on PATH. It answers `pr view --json ...` from a JSON file this spec rewrites per test —
 * so "what GitHub says" is a first-class knob — and for `pr merge` it copies `--body-file`'s CONTENT to
 * a capture file, so the spec asserts the exact bytes that would have reached main.
 */
function installFakeGh(): void {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const gh = path.join(bin, 'gh');
    fs.writeFileSync(gh, [
        '#!/bin/sh',
        `echo "$@" >> "${ghLog}"`,
        'if [ "$1 $2" = "pr view" ]; then',
        '  case "$*" in',
        `    *headRefOid*) cat "${path.join(tmp, 'pr.json')}" ;;`,
        "    *mergeable*) printf 'MERGEABLE\\tCLEAN\\tOPEN\\n' ;;",
        "    *) printf '{}\\n' ;;",
        '  esac',
        '  exit 0',
        'fi',
        'if [ "$1 $2" = "pr merge" ]; then',
        '  prev=""',
        '  for a in "$@"; do',
        `    if [ "$prev" = "--body-file" ]; then cp "$a" "${ghBodyCapture}"; fi`,
        '    prev="$a"',
        '  done',
        '  echo merged',
        '  exit 0',
        'fi',
        'exit 0',
    ].join('\n'));
    fs.chmodSync(gh, 0o755);
    process.env['PATH'] = `${bin}${path.delimiter}${savedPath ?? ''}`;
}

// Publish what `gh pr view --json number,title,url,body,headRefOid` should answer.
function ghPrSays(body: string, headRefOid: string): void {
    fs.writeFileSync(path.join(tmp, 'pr.json'), JSON.stringify({
        number: 604,
        title: 'Land the thing',
        url: 'https://github.com/acme/widgets/pull/604',
        body,
        headRefOid,
        // The other half of the pair that identifies the PR's tree locally. GitHub is the authority on
        // which branch the PR merges — the command never infers it from the directory it is in.
        headRefName: BRANCH,
    }));
}

// No open PR for this head branch: `gh` exits non-zero, exactly as it does in real life.
function ghHasNoPr(): void {
    fs.rmSync(path.join(tmp, 'pr.json'), { force: true });
    const gh = path.join(tmp, 'bin', 'gh');
    fs.writeFileSync(gh, ['#!/bin/sh', `echo "$@" >> "${ghLog}"`, 'exit 1'].join('\n'));
    fs.chmodSync(gh, 0o755);
}

/**
 * The repo root IS whatever directory the command resolved as its invocation cwd. That makes this
 * seam the assertion for the whole cwd fix: every temp tree below is a git root, so a repo root that
 * comes back as the hoisted directory rather than the invoked one is the bug, visibly.
 */
class CwdRepoRootFinder extends RepoRootFinder {
    override resolveRepoRoot(cwd: string): string {
        return cwd;
    }
}

// The command with every collaborator REAL. Only repo-root resolution is pinned, because the temp clone
// has no enclosing workspace to discover.
function build(): LandPrCommand {
    const naming = new BranchNaming();
    return new LandPrCommand(
        new CwdRepoRootFinder(),
        new AiBranchName(naming),
        naming,
        new PrMerger(),
        new BranchArchiver(),
        new MergeInfoIndex(new MergeState()),
        new LandedWorktreeReaper(new WorktreeService(), new ReapOutcomeSignal()),
        new MergeBodyTempFile(),
        new LandedTreeResolver(new WorktreeService()),
    );
}

/**
 * Runs the command as `pnpm` really runs it: `INIT_CWD` is the directory the operator typed in, and
 * `process.cwd()` is wherever pnpm HOISTED the bin to. They are the same for a plain invocation, and
 * they are emphatically not the same from a nested agent worktree — which is the bug under test.
 */
async function landFrom(invocationDir: string, hoistedCwd: string, request: LandPrRequest): Promise<string> {
    let out = '';
    const write = process.stdout.write.bind(process.stdout);
    // webpieces-disable no-any-unknown -- stubbing node's write signature for the duration of one run
    process.stdout.write = ((chunk: string): boolean => {
        out += chunk;
        return true;
    }) as unknown as typeof process.stdout.write;
    process.chdir(hoistedCwd);
    process.env['INIT_CWD'] = invocationDir;
    return build().run(request).then(
        (): string => {
            process.stdout.write = write;
            process.chdir(savedCwd);
            return out;
        },
        (err: unknown): never => {
            process.stdout.write = write;
            process.chdir(savedCwd);
            throw toError(err);
        });
}

// The ordinary invocation: typed in `treeRoot`, hoisted nowhere, no flags.
async function land(treeRoot: string): Promise<string> {
    return landFrom(treeRoot, treeRoot, new LandPrRequest(false, ''));
}

// The refusal message, asserted without a catch block (catch-error-pattern). It ALSO asserts the call
// really refused, so a test that stops refusing fails rather than silently passing.
async function refusalMessage(treeRoot: string): Promise<string> {
    const thrown = await land(treeRoot).then(
        (): Error | null => null,
        (err: unknown): Error => toError(err));
    expect(thrown).toBeInstanceOf(InformAiError);
    return thrown?.message ?? '';
}

function landedBody(): string {
    return fs.existsSync(ghBodyCapture) ? fs.readFileSync(ghBodyCapture, 'utf8') : '';
}

beforeEach((): void => {
    savedCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-land-pr-'));
    ghLog = path.join(tmp, 'gh.log');
    ghBodyCapture = path.join(tmp, 'landed-body.md');
    installFakeGh();
    primary = makeClone('primary');
    prBody = PR_DESCRIPTION;
    prHeadOid = git(primary, 'rev-parse', BRANCH);
    ghPrSays(prBody, prHeadOid);
});

afterEach((): void => {
    process.chdir(savedCwd);
    if (savedPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = savedPath;
    if (savedInitCwd === undefined) delete process.env['INIT_CWD'];
    else process.env['INIT_CWD'] = savedInitCwd;
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('wp-land-pr — the commit body comes from the PR description', () => {
    it('lands the EXACT bytes GitHub holds as the description', async (): Promise<void> => {
        const out = await land(primary);

        expect(landedBody()).toBe(PR_DESCRIPTION);
        expect(out).toContain('Landing PR #604');
        expect(out).toContain('Landed');
    });

    /**
     * The whole point of the change: no local receipt is consulted, so no local receipt can be missing.
     * A clone that has NEVER run `pnpm wp-finish-upsert-pr` lands the reviewed bytes just the same.
     */
    it('lands from a clone that never rendered anything — nothing local is read', async (): Promise<void> => {
        const second = makeClone('second-clone');

        await land(second);

        expect(landedBody()).toBe(PR_DESCRIPTION);
    });

    /** GitHub stores descriptions with CRLF; a commit body must not carry them. */
    it('normalizes CRLF out of the description before it becomes a commit body', async (): Promise<void> => {
        ghPrSays('line one\r\nline two\r\n', prHeadOid);

        await land(primary);

        expect(landedBody()).toBe('line one\nline two\n');
    });

    /** The body is never re-rendered here — landing has no dashboard, no review.json, no gate. */
    it('never regenerates the body: whatever the PR says is what lands', async (): Promise<void> => {
        ghPrSays('BYTES ONLY THE PR COULD KNOW\n', prHeadOid);

        await land(primary);

        expect(landedBody()).toBe('BYTES ONLY THE PR COULD KNOW\n');
    });
});

describe('wp-land-pr — the bookkeeping half is re-derived from headRefOid', () => {
    it('DOES archive when this tree\'s branch is the commit the PR squashed', async (): Promise<void> => {
        const out = await land(primary);

        expect(out).not.toContain('SKIPPED');
        expect(git(primary, 'tag', '--list', 'archive/*')).toContain(`/${BRANCH}`);
    });

    /**
     * A second clone's `<branch>` is a different commit. Archiving there would tag the wrong objects
     * under the right name — the exact defect the old `origin.json` treeRoot check existed to prevent,
     * now caught by a fact rather than by a recorded claim.
     */
    it('declines the bookkeeping OUT LOUD when this tree holds a different commit', async (): Promise<void> => {
        const second = makeClone('second-clone');

        const out = await land(second);

        expect(landedBody()).toBe(PR_DESCRIPTION);
        expect(out).toContain('Archive + worktree cleanup SKIPPED');
        expect(out).toContain(prHeadOid);
        expect(out).toContain(git(second, 'rev-parse', BRANCH));
        // The wrong-objects rail: no archive tag in the clone that does not hold the landed commit.
        expect(git(second, 'tag', '--list', 'archive/*')).toBe('');
    });

    /**
     * The case `origin.json` got WRONG and the sha check gets right: a linked worktree of the SAME
     * clone shares git's refs, so its `<branch>` really is the landed commit and archiving from there
     * is correct. The old check declined it purely because a different directory string was recorded.
     */
    it('archives from a LINKED WORKTREE of the same clone, which holds the same commit', async (): Promise<void> => {
        const worktree = path.join(tmp, 'wt-a');
        git(primary, 'worktree', 'add', '-q', '--detach', worktree);
        git(primary, 'checkout', '-q', 'main');
        git(worktree, 'checkout', '-q', BRANCH);
        writeConfig(worktree);

        const out = await land(worktree);

        expect(landedBody()).toBe(PR_DESCRIPTION);
        expect(out).not.toContain('SKIPPED');
        expect(git(primary, 'tag', '--list', 'archive/*')).toContain(`/${BRANCH}`);
    });
});

describe('wp-land-pr — the invocation directory, not pnpm\'s hoisted one', () => {
    /**
     * THE BUG, pinned. A Claude Code agent worktree lives at `<primary>/.claude/worktrees/agent-<id>` —
     * INSIDE the primary clone — so `pnpm` walks up past the worktree root and executes the bin in the
     * primary clone. `git branch --show-current` then answered `main`, `gh pr view main` found nothing,
     * and every `/full-cycle` run was told "No open PR found for this branch" about a PR that was open.
     *
     * The nesting is what makes this specific to agent worktrees: a worktree OUTSIDE the clone does not
     * hoist past its own root, which is why this was never caught.
     */
    it('reads the NESTED agent worktree\'s branch, not the primary clone\'s', async (): Promise<void> => {
        const agent = path.join(primary, '.claude', 'worktrees', 'agent-x');
        fs.mkdirSync(path.dirname(agent), { recursive: true });
        git(primary, 'worktree', 'add', '-q', '--detach', agent);
        git(primary, 'checkout', '-q', 'main');
        git(agent, 'checkout', '-q', BRANCH);
        writeConfig(agent);

        // Typed in the agent worktree; pnpm hoisted the process into the primary clone, which is on main.
        const out = await landFrom(agent, primary, new LandPrRequest(false, ''));

        expect(fs.readFileSync(ghLog, 'utf8')).toContain(`pr view ${BRANCH}`);
        expect(fs.readFileSync(ghLog, 'utf8')).not.toContain('pr view main');
        expect(landedBody()).toBe(PR_DESCRIPTION);
        expect(out).toContain('Landing PR #604');
        expect(out).not.toContain('SKIPPED');
        expect(git(primary, 'tag', '--list', 'archive/*')).toContain(`/${BRANCH}`);
    });

    /**
     * The other half of the ask: an agent that built a branch is often long gone by the time its PR is
     * landable, and its worktree is a directory nobody is standing in. `--pr <n>` lets a coordinator on
     * `main` in the primary clone finish the job — and the bookkeeping still resolves to the agent's
     * tree, because it is found by `(headRefName, headRefOid)` rather than by where anyone is standing.
     */
    it('lands --pr <n> from the primary clone and still finds the agent\'s worktree', async (): Promise<void> => {
        const agent = path.join(primary, '.claude', 'worktrees', 'agent-y');
        fs.mkdirSync(path.dirname(agent), { recursive: true });
        git(primary, 'worktree', 'add', '-q', '--detach', agent);
        git(primary, 'checkout', '-q', 'main');
        git(agent, 'checkout', '-q', BRANCH);
        writeConfig(agent);

        const out = await landFrom(primary, primary, new LandPrRequest(true, '604'));

        expect(fs.readFileSync(ghLog, 'utf8')).toContain('pr view 604');
        expect(landedBody()).toBe(PR_DESCRIPTION);
        expect(out).not.toContain('SKIPPED');
        // The reap names the AGENT's directory, not the clone the coordinator is standing in.
        expect(out).toContain(agent);
        expect(git(primary, 'tag', '--list', 'archive/*')).toContain(`/${BRANCH}`);
    });

    /** `--pr` with no number must refuse, never silently fall back to this directory's branch. */
    it('refuses --pr without a number rather than guessing a PR', async (): Promise<void> => {
        const thrown = await landFrom(primary, primary, new LandPrRequest(true, '')).then(
            (): Error | null => null,
            (err: unknown): Error => toError(err));

        expect(thrown).toBeInstanceOf(InformAiError);
        expect(thrown?.message ?? '').toContain('--pr needs a PR NUMBER');
        // It refused BEFORE touching gh at all — no PR was looked up, and nothing was merged.
        expect(fs.existsSync(ghLog)).toBe(false);
        expect(landedBody()).toBe('');
    });
});

describe('wp-land-pr — refusals', () => {
    it('refuses when there is no open PR, and does NOT merge', async (): Promise<void> => {
        ghHasNoPr();

        const message = await refusalMessage(primary);

        expect(message).toContain('No open PR found for this branch');
        expect(message).toContain('wp-finish-upsert-pr');
        expect(fs.readFileSync(ghLog, 'utf8')).not.toContain('pr merge');
        expect(landedBody()).toBe('');
    });

    it('refuses an EMPTY description rather than landing a blank commit body', async (): Promise<void> => {
        ghPrSays('', prHeadOid);

        const message = await refusalMessage(primary);

        expect(message).toContain('has an EMPTY description');
        expect(message).toContain('pnpm wp-finish-upsert-pr');
        expect(fs.readFileSync(ghLog, 'utf8')).not.toContain('pr merge');
        expect(landedBody()).toBe('');
    });

    /**
     * The TRANSITION hazard, and the reason this refusal exists at all.
     *
     * A PR posted by a release older than the surface swap still carries the FULL DASHBOARD as its
     * description. Measured on this repo on 2026-08-07: PR #613 (posted after the swap) has a
     * description byte-identical to its squash-commit body, while PR #614 — open, posted four minutes
     * earlier — still began `## 🚦 PR Gate Dashboard`. Landing that one would put a risk table in main
     * forever, which is exactly what `decisions/0004` § 4.1 warned against.
     *
     * The check is not a guess about what a dashboard looks like: it is the property
     * `pr-body-is-merge-body.spec.ts` already pins on the renderer ("contains nothing a plain-text git
     * log cannot carry"), read from the other end against bytes that came from outside the process.
     */
    it('refuses a description that is still the OLD full dashboard', async (): Promise<void> => {
        ghPrSays('## 🚦 PR Gate Dashboard\n\n**Risk Score:** 20/100\n', prHeadOid);

        const message = await refusalMessage(primary);

        expect(message).toContain('is not a git-log commit body');
        expect(message).toContain('markdown heading');
        expect(message).toContain('pnpm wp-finish-upsert-pr');
        expect(fs.readFileSync(ghLog, 'utf8')).not.toContain('pr merge');
        expect(landedBody()).toBe('');
    });

    it('refuses a description carrying a markdown TABLE, which a squash commit cannot render', async (): Promise<void> => {
        ghPrSays('Summary\n\n| gate | result |\n|---|---|\n| build | ok |\n', prHeadOid);

        const message = await refusalMessage(primary);

        expect(message).toContain('markdown table');
        expect(landedBody()).toBe('');
    });

    /**
     * The refusal names BOTH causes, and explicitly does not blame the author's prose.
     *
     * It used to assert an old release as "the usual cause". When the marker had instead come from author
     * text — a `|` in a summary, from a TypeScript union or a regex alternation — re-running finish
     * re-rendered the identical character from the unchanged `review.json`, so landing refused again: a
     * loop costing a CI cycle per turn. `Dashboard.gitLogSafe` closed the render side; this pins that the
     * message stopped teaching the diagnosis that sent readers looking for a version skew.
     */
    it('names a hand edit as well as an old release, and does not blame the review text', async (): Promise<void> => {
        ghPrSays('Summary\n\n| gate | result |\n', prHeadOid);

        const message = await refusalMessage(primary);

        expect(message).toContain('EDITED BY HAND');
        expect(message).toContain('OLDER');
        expect(message).toContain('does NOT require removing');
        expect(message).not.toContain('The usual cause');
    });

    /** It must not fire on the real thing — the compact body is what finish actually publishes. */
    it('does NOT refuse the compact gated body', async (): Promise<void> => {
        await land(primary);

        expect(landedBody()).toBe(PR_DESCRIPTION);
    });

    /**
     * The DELETED escape hatch, asserted by absence.
     *
     * `--fallback-title-only` existed for exactly one situation: the gated bytes were on a different
     * COMPUTER. That is unreachable now, so per the repo's no-backwards-compatibility rule the flag,
     * its `LandPrOptions`, and the degraded body it wrote are gone rather than deprecated — and the
     * refusal above must not teach them either (shim shape #6).
     */
    it('never mentions the removed --fallback-title-only escape', async (): Promise<void> => {
        ghPrSays('', prHeadOid);

        const message = await refusalMessage(primary);

        expect(message).not.toContain('fallback-title-only');
        expect(message).not.toContain('not found on this machine');
        expect(message).not.toContain('WEBPIECES_STATE_HOME');
    });

    /**
     * `--pr <n>` is the ONE knob, and it selects WHICH PR — never anything about the bytes that land.
     * The moment a second field appears here, somebody has re-opened the question decisions/0005 closed
     * by making GitHub the holder of the commit body.
     */
    it('has exactly one knob, and it selects the PR rather than the commit body', (): void => {
        expect(Object.keys(new LandPrRequest(true, '604'))).toEqual(['prFlagPresent', 'prNumber']);
    });
});
