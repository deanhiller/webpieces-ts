import { CheckoutLayout, policyFixture } from '@webpieces/tooling-testkit';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BranchArchiver } from '@webpieces/repo-workflow-core';
import { GitProcessApi, GitResultDto, InformAiError, NativeProcessApi, ProcessResultDto } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { RepoRootFinder } from '@webpieces/rules-config';
import { MockNativeProcessApi, ProcessCallDto } from '@webpieces/tooling-testkit';

import { LandPrCommand, LandPrRequest } from './land-pr-command';
import { RepoConfigFixture } from '../workflow/repo-config-testkit';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { LandedTreeResolver } from '../workflow/landed-tree-resolver';
import { LandedWorktreeReaper } from '../workflow/landed-worktree-reaper';
import { MergeBodyTempFile } from '../workflow/merge-body-temp-file';
import { MergeInfoIndex } from '../workflow/merge-info-index';
import { PrMerger } from '../workflow/pr-merger';
import { PrGateFeature } from '../../__tests__/feature-harness';

/**
 * The READ half of the finish→land contract, end to end through the real PrMerger.
 *
 * `gh` is SCRIPTED on the injected NativeProcessApi (#1381): every call it receives is recorded and, for
 * `pr merge --body-file <f>`, the file's BYTES are copied aside. That is the only assertion worth making
 * about this command: what exactly reached main's history. Nothing here touches the network, and no
 * merge is ever performed.
 *
 * git is SCRIPTED too (#1381): the bookkeeping half (archive tags, the worktree lookup) is
 * `@webpieces/repo-workflow-core`'s, and it now reaches git through the same injected edge. Each clone is a
 * {@link ScriptedClone} — its branch tips, which worktree holds which branch at which commit, the tags the
 * program created — answering every command exactly as git would. The `.git` layout of each tree is laid
 * out on disk by CheckoutLayout (no git), because the state readers (DotWebpieces) read it from files.
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
// What `wp-finish-upsert-pr` publishes as the PR description, verbatim. See dashboard.renderPrBody and
// pr-body-is-merge-body.spec.ts: this string IS both surfaces.
const PR_DESCRIPTION = 'https://github.com/acme/widgets/pull/604\n\nRisk: green\n\nSummary.\n';

/** One working tree of a clone: where it is, and what it has checked out. Data only. */
class TreeState {
    constructor(readonly path: string, public branch: string) {}
}

/**
 * One clone of "acme/widgets" as git knows it: ONE set of refs (branch tips, tags) shared by the primary
 * tree and every linked worktree, and which branch each tree has checked out.
 */
class ScriptedClone {
    readonly branches = new Map<string, string>();
    readonly tags = new Map<string, string>();
    readonly trees: TreeState[] = [];

    constructor(readonly primary: string) {
        this.trees.push(new TreeState(primary, BRANCH));
    }

    /** Does `cwd` lie in one of this clone's trees? The innermost (longest) tree wins. */
    treeAt(cwd: string): TreeState | undefined {
        return this.trees
            .filter((tree: TreeState): boolean => cwd === tree.path || cwd.startsWith(`${tree.path}${path.sep}`))
            .sort((a: TreeState, b: TreeState): number => b.path.length - a.path.length)[0];
    }

    answer(call: ProcessCallDto, tree: TreeState): GitResultDto {
        const args = call.args;
        const line = args.join(' ');
        if (line === 'branch --show-current') return this.ok(tree.branch);
        if (line === 'worktree list --porcelain') return new GitResultDto(0, this.porcelain(), '');
        if (args[0] === 'tag' && args.length === 3) {
            if (this.tags.has(args[1])) return new GitResultDto(128, '', `fatal: tag '${args[1]}' already exists`);
            this.tags.set(args[1], args[2]);
            return new GitResultDto(0, '', '');
        }
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
            return new GitResultDto(this.tags.has(args[3].replace('refs/tags/', '')) ? 0 : 1, '', '');
        }
        if (args[0] === 'rev-parse' && args[1].startsWith('refs/tags/')) {
            const sha = this.tags.get(args[1].replace('refs/tags/', '').replace('^{commit}', ''));
            return sha === undefined ? this.unknown(args[1]) : this.ok(sha);
        }
        if (args[0] === 'rev-parse' && args.length === 2) {
            const sha = this.branches.get(args[1]);
            // No remote has ever been fetched, so `origin/main` is unknown — exactly as in a fresh clone.
            return sha === undefined ? this.unknown(args[1]) : this.ok(sha);
        }
        return new GitResultDto(1, '', `unscripted git ${line}`);
    }

    /** The archive tags in this clone — what `git tag --list 'archive/*'` would print. */
    archiveTags(): string {
        return [...this.tags.keys()].filter((tag: string): boolean => tag.startsWith('archive/')).join('\n');
    }

    private porcelain(): string {
        return this.trees.map((tree: TreeState): string =>
            `worktree ${tree.path}\nHEAD ${this.branches.get(tree.branch) ?? ''}\nbranch refs/heads/${tree.branch}\n`).join('\n');
    }

    private ok(stdout: string): GitResultDto {
        return new GitResultDto(0, `${stdout}\n`, '');
    }

    private unknown(ref: string): GitResultDto {
        return new GitResultDto(128, `${ref}\n`, `fatal: ambiguous argument '${ref}': unknown revision or path not in the working tree.`);
    }
}

let tmp = '';
let primary = '';
let primaryClone: ScriptedClone;
const clones: ScriptedClone[] = [];
let landed = '';
let savedCwd = '';
let prBody = PR_DESCRIPTION;
let prHeadOid = '';
let prJson: string | null = null;
let feature: PrGateFeature;
let gh: MockNativeProcessApi;
const savedInitCwd = process.env['INIT_CWD'];

/**
 * THIS repo's own webpieces.config.json, prepared for a temp clone by RepoConfigFixture — the real file
 * rather than a hand-rolled stub, so the spec exercises the same validator the tool really faces. Written
 * BEFORE the tree's `.git` is laid out: the fixture stages its files when it finds a `.git`, and this
 * spec starts no git.
 */
function writeConfig(dir: string): void {
    const fixture = new RepoConfigFixture();
    fixture.writeTo(dir, fixture.load());
}

// A clone of "acme/widgets" with a main commit and the feature branch checked out.
function makeClone(name: string): ScriptedClone {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'work\n');
    CheckoutLayout.primary(dir, BRANCH);
    const clone = new ScriptedClone(dir);
    clone.branches.set('main', `main-of-${name}`);
    // Every clone commits its OWN feature work, so the same branch name is a different commit in each.
    clone.branches.set(BRANCH, `feature-of-${name}`);
    clones.push(clone);
    return clone;
}

/**
 * A linked worktree of the primary clone, holding the feature branch while the primary goes back to main —
 * what `git worktree add --detach <wt>`, `git checkout main` in the primary and `git checkout <branch>`
 * in the worktree leave behind.
 */
function addWorktreeHoldingBranch(worktree: string): void {
    fs.mkdirSync(worktree, { recursive: true });
    // Checking the branch out materializes its committed files — the primary clone's, which hold the
    // same commit — so the worktree carries the same owner policy files beside its config.
    for (const entry of fs.readdirSync(primary)) {
        if (entry === '.git' || entry === '.claude') continue;
        fs.cpSync(path.join(primary, entry), path.join(worktree, entry), { recursive: true });
    }
    writeConfig(worktree);
    CheckoutLayout.linkedWorktree(primary, worktree, BRANCH);
    CheckoutLayout.checkoutBranch(primary, 'main');
    primaryClone.trees[0].branch = 'main';
    primaryClone.trees.push(new TreeState(worktree, BRANCH));
}

/**
 * What GitHub answers. `pr view --json ...headRefOid...` comes from `prJson` (null = no open PR, and gh
 * exits non-zero exactly as it does in real life), so "what GitHub says" is a first-class knob; for
 * `pr merge` the `--body-file`'s CONTENT is captured, so the spec asserts the exact bytes that would
 * have reached main.
 */
function scriptGitHub(): void {
    gh.respondToPrefix('gh', ['pr', 'view'], (call: ProcessCallDto): ProcessResultDto => {
        if (call.args.join(' ').includes('mergeable')) return gh.ok('MERGEABLE\tCLEAN\tOPEN\n');
        return prJson === null ? gh.fail(1, 'no pull requests found') : gh.ok(prJson);
    });
    gh.respondToPrefix('gh', ['pr', 'merge'], (call: ProcessCallDto): ProcessResultDto => {
        const at = call.args.indexOf('--body-file');
        if (at >= 0) landed = fs.readFileSync(call.args[at + 1], 'utf8');
        return gh.ok('merged\n');
    });
}

// git answers from whichever clone owns the directory the command runs in.
function scriptGit(): void {
    feature.git.respondToPrefix([], (call: ProcessCallDto): GitResultDto => {
        for (const clone of clones) {
            const tree = clone.treeAt(call.cwd ?? '');
            if (tree !== undefined) return clone.answer(call, tree);
        }
        return new GitResultDto(128, '', `fatal: not a git repository: ${call.cwd ?? ''}`);
    });
}

/** Every `gh` command line the program issued, the way the old on-PATH script logged them. */
function ghLog(): string {
    return gh.calls.map((c: ProcessCallDto): string => c.args.join(' ')).join('\n');
}

// Publish what `gh pr view --json number,title,url,body,headRefOid` should answer.
function ghPrSays(body: string, headRefOid: string): void {
    prJson = JSON.stringify({
        number: 604,
        title: 'Land the thing',
        url: 'https://github.com/acme/widgets/pull/604',
        body,
        headRefOid,
        // The other half of the pair that identifies the PR's tree locally. GitHub is the authority on
        // which branch the PR merges — the command never infers it from the directory it is in.
        headRefName: BRANCH,
    });
}

// No open PR for this head branch: `gh` exits non-zero, exactly as it does in real life.
function ghHasNoPr(): void {
    prJson = null;
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

// The command with every collaborator from the shipped container. Only repo-root resolution is pinned,
// because the temp clone has no enclosing workspace to discover; git and `gh` are the scripted edges.
function build(): LandPrCommand {
    const container = feature.container;
    return new LandPrCommand(
        new CwdRepoRootFinder(),
        container.get(AiBranchName),
        container.get(BranchNaming),
        container.get(PrMerger),
        container.get(BranchArchiver),
        container.get(MergeInfoIndex),
        container.get(LandedWorktreeReaper),
        container.get(MergeBodyTempFile),
        container.get(LandedTreeResolver),
        container.get(GitProcessApi),
        container.get(NativeProcessApi),
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
    return landed;
}

beforeEach(async (): Promise<void> => {
    savedCwd = process.cwd();
    // realpath: git reports worktree paths resolved (/private/var/… on macOS), so the model does too.
    tmp = fs.realpathSync(policyFixture.makeRepo('wp-land-pr-'));
    landed = '';
    clones.length = 0;
    feature = await PrGateFeature.create();
    gh = feature.processes;
    scriptGitHub();
    scriptGit();
    primaryClone = makeClone('primary');
    primary = primaryClone.primary;
    prBody = PR_DESCRIPTION;
    prHeadOid = primaryClone.branches.get(BRANCH) ?? '';
    ghPrSays(prBody, prHeadOid);
});

afterEach((): void => {
    process.chdir(savedCwd);
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

        await land(second.primary);

        expect(landedBody()).toBe(PR_DESCRIPTION);
    });

    /** GitHub stores descriptions with CRLF; a commit body must not carry them. */
    it('normalizes CRLF out of the description before it becomes a commit body', async (): Promise<void> => {
        ghPrSays('line one\r\nline two\r\n', prHeadOid);

        await land(primary);

        expect(landedBody()).toBe('line one\nline two\n');
    });

    /** The body is never re-rendered here — landing has no dashboard, no summary.json, no gate. */
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
        expect(primaryClone.archiveTags()).toContain(`/${BRANCH}`);
        // The tag points at the commit GitHub squashed, and was issued in this clone.
        expect(feature.git.calls.some((call: ProcessCallDto): boolean =>
            call.cwd === primary && call.args[0] === 'tag' && call.args[2] === prHeadOid)).toBe(true);
    });

    /**
     * A second clone's `<branch>` is a different commit. Archiving there would tag the wrong objects
     * under the right name — the exact defect the old `origin.json` treeRoot check existed to prevent,
     * now caught by a fact rather than by a recorded claim.
     */
    it('declines the bookkeeping OUT LOUD when this tree holds a different commit', async (): Promise<void> => {
        const second = makeClone('second-clone');

        const out = await land(second.primary);

        expect(landedBody()).toBe(PR_DESCRIPTION);
        expect(out).toContain('Archive + worktree cleanup SKIPPED');
        expect(out).toContain(prHeadOid);
        expect(out).toContain(second.branches.get(BRANCH) ?? '<missing>');
        // The wrong-objects rail: no archive tag in the clone that does not hold the landed commit.
        expect(second.archiveTags()).toBe('');
        expect(feature.git.commandLines().some((line: string): boolean => line.startsWith('git tag '))).toBe(false);
    });

    /**
     * The case `origin.json` got WRONG and the sha check gets right: a linked worktree of the SAME
     * clone shares git's refs, so its `<branch>` really is the landed commit and archiving from there
     * is correct. The old check declined it purely because a different directory string was recorded.
     */
    it('archives from a LINKED WORKTREE of the same clone, which holds the same commit', async (): Promise<void> => {
        const worktree = path.join(tmp, 'wt-a');
        addWorktreeHoldingBranch(worktree);

        const out = await land(worktree);

        expect(landedBody()).toBe(PR_DESCRIPTION);
        expect(out).not.toContain('SKIPPED');
        expect(primaryClone.archiveTags()).toContain(`/${BRANCH}`);
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
        addWorktreeHoldingBranch(agent);

        // Typed in the agent worktree; pnpm hoisted the process into the primary clone, which is on main.
        const out = await landFrom(agent, primary, new LandPrRequest(false, ''));

        expect(ghLog()).toContain(`pr view ${BRANCH}`);
        expect(ghLog()).not.toContain('pr view main');
        expect(landedBody()).toBe(PR_DESCRIPTION);
        expect(out).toContain('Landing PR #604');
        expect(out).not.toContain('SKIPPED');
        expect(primaryClone.archiveTags()).toContain(`/${BRANCH}`);
        // The branch was asked of the directory the operator TYPED in, not of the hoisted cwd.
        expect(feature.git.calls.find((call: ProcessCallDto): boolean =>
            call.args.join(' ') === 'branch --show-current')?.cwd).toBe(agent);
    });

    /**
     * The other half of the ask: an agent that built a branch is often long gone by the time its PR is
     * landable, and its worktree is a directory nobody is standing in. `--pr <n>` lets a coordinator on
     * `main` in the primary clone finish the job — and the bookkeeping still resolves to the agent's
     * tree, because it is found by `(headRefName, headRefOid)` rather than by where anyone is standing.
     */
    it('lands --pr <n> from the primary clone and still finds the agent\'s worktree', async (): Promise<void> => {
        const agent = path.join(primary, '.claude', 'worktrees', 'agent-y');
        addWorktreeHoldingBranch(agent);

        const out = await landFrom(primary, primary, new LandPrRequest(true, '604'));

        expect(ghLog()).toContain('pr view 604');
        expect(landedBody()).toBe(PR_DESCRIPTION);
        expect(out).not.toContain('SKIPPED');
        // The reap names the AGENT's directory, not the clone the coordinator is standing in.
        expect(out).toContain(agent);
        expect(primaryClone.archiveTags()).toContain(`/${BRANCH}`);
    });

    /** `--pr` with no number must refuse, never silently fall back to this directory's branch. */
    it('refuses --pr without a number rather than guessing a PR', async (): Promise<void> => {
        const thrown = await landFrom(primary, primary, new LandPrRequest(true, '')).then(
            (): Error | null => null,
            (err: unknown): Error => toError(err));

        expect(thrown).toBeInstanceOf(InformAiError);
        expect(thrown?.message ?? '').toContain('--pr needs a PR NUMBER');
        // It refused BEFORE touching gh at all — no PR was looked up, and nothing was merged.
        expect(gh.calls).toEqual([]);
        expect(landedBody()).toBe('');
    });
});

describe('wp-land-pr — refusals', () => {
    it('refuses when there is no open PR, and does NOT merge', async (): Promise<void> => {
        ghHasNoPr();

        const message = await refusalMessage(primary);

        expect(message).toContain('No open PR found for this branch');
        expect(message).toContain('wp-finish-upsert-pr');
        expect(ghLog()).not.toContain('pr merge');
        expect(landedBody()).toBe('');
    });

    it('refuses an EMPTY description rather than landing a blank commit body', async (): Promise<void> => {
        ghPrSays('', prHeadOid);

        const message = await refusalMessage(primary);

        expect(message).toContain('has an EMPTY description');
        expect(message).toContain('pnpm wp-finish-upsert-pr');
        expect(ghLog()).not.toContain('pr merge');
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
        expect(ghLog()).not.toContain('pr merge');
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
     * re-rendered the identical character from the unchanged `summary.json`, so landing refused again: a
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
