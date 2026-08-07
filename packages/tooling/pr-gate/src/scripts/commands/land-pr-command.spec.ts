import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    BranchArchiver, InformAiError, MachineStateHome, PrBodyOrigin, PrBodyStore, RepoRootFinder,
    WEBPIECES_STATE_HOME_ENV, WorktreeService, toError,
} from '@webpieces/rules-config';

import { LandPrCommand, LandPrOptions } from './land-pr-command';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { LandedWorktreeReaper } from '../workflow/landed-worktree-reaper';
import { MergeInfoIndex } from '../workflow/merge-info-index';
import { MergeState } from '../workflow/merge-state';
import { PrMerger } from '../workflow/pr-merger';

/**
 * The READ half of the finish→land contract, end to end through the real PrMerger.
 *
 * `gh` is a REAL executable on PATH — a shell script that logs every invocation and, for
 * `pr merge --body-file <f>`, copies the file's BYTES aside. That is the only assertion worth making
 * about this command: what exactly reached main's history. Nothing here touches the network, and no
 * merge is ever performed.
 *
 * The scenarios are the ones the incident produced: finish ran in the primary clone, landing happened
 * somewhere else.
 */

const BRANCH = 'dean/feature';
const REMOTE = 'git@github.com:acme/widgets.git';
const GATED_BODY = 'risk: green\nflags: none\nhttps://github.com/acme/widgets/pull/604\n';
// What a real consuming repo's PR description looks like, and what must NEVER reach a commit body.
const PR_DESCRIPTION_MARKER = 'PR Gate Dashboard';

let tmp = '';
let stateHome = '';
let primary = '';
let ghLog = '';
let ghBodyCapture = '';
let savedCwd = '';
const savedPath = process.env['PATH'];
const savedOverride = process.env[WEBPIECES_STATE_HOME_ENV];

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * THIS repo's own webpieces.config.json, minus `checklists`.
 *
 * The real file is used (rather than a hand-rolled minimal one) so the spec exercises the same
 * validator the tool really faces — a hand-written stub would drift out from under it on the next
 * config change. `checklists` is dropped because its `doc` paths are validated as REPO-RELATIVE and
 * point at `.claude/review/*.md`, which exist in this repo and not in a temp clone; landing never reads
 * them.
 */
function writeConfig(dir: string): void {
    const source = path.join(__dirname, '..', '..', '..', '..', '..', '..', 'webpieces.config.json');
    // webpieces-disable no-any-unknown -- the repo's own config, opaque here; only one key is removed
    const config = JSON.parse(fs.readFileSync(source, 'utf8')) as Record<string, unknown>;
    // webpieces-disable no-any-unknown -- narrowing one nested section to delete a single key
    const commands = config['commands'] as Record<string, Record<string, unknown>>;
    delete commands['pr-gate']['checklists'];
    delete commands['pr-gate']['checklistsWhy'];
    fs.writeFileSync(path.join(dir, 'webpieces.config.json'), JSON.stringify(config, null, 4) + '\n');
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
 * A real `gh` on PATH. It answers the reads this flow makes and records every invocation, and for
 * `pr merge` it copies `--body-file`'s CONTENT to a capture file — so the spec asserts the exact bytes
 * that would have reached main, not the path they came from.
 *
 * Its "PR description" answer exists purely so the fallback test can prove those bytes never appear in
 * a commit body even when they are one `gh` call away.
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
        "    *number,title,url*) printf '604\\tLand the thing\\thttps://github.com/acme/widgets/pull/604\\n' ;;",
        "    *mergeable*) printf 'MERGEABLE\\tCLEAN\\tOPEN\\n' ;;",
        `    *) printf '## ${PR_DESCRIPTION_MARKER}\\n| build | ok |\\n' ;;`,
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

class FixedRepoRootFinder extends RepoRootFinder {
    constructor(private readonly root: string) {
        super();
    }

    override resolveRepoRoot(): string {
        return this.root;
    }
}

// The command with every collaborator REAL. Only the repo root is pinned, because the temp clone has no
// enclosing workspace to discover.
function build(treeRoot: string): LandPrCommand {
    const naming = new BranchNaming();
    return new LandPrCommand(
        new FixedRepoRootFinder(treeRoot),
        new AiBranchName(naming),
        naming,
        new PrMerger(),
        new BranchArchiver(),
        new MergeInfoIndex(new MergeState()),
        new LandedWorktreeReaper(new WorktreeService()),
        new PrBodyStore(new MachineStateHome()),
    );
}

// Runs the command from `treeRoot`, capturing stdout. `git branch --show-current` and PrMerger both
// read process.cwd(), so the tree we claim to be landing from has to really be the cwd.
async function land(treeRoot: string, opts: LandPrOptions = new LandPrOptions()): Promise<string> {
    let out = '';
    const write = process.stdout.write.bind(process.stdout);
    // webpieces-disable no-any-unknown -- stubbing node's write signature for the duration of one run
    process.stdout.write = ((chunk: string): boolean => {
        out += chunk;
        return true;
    }) as unknown as typeof process.stdout.write;
    process.chdir(treeRoot);
    return build(treeRoot).run(opts).then(
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

// The refusal message, asserted without a catch block (catch-error-pattern). It ALSO asserts the call
// really refused, so a test that stops refusing fails rather than silently passing.
async function refusalMessage(treeRoot: string): Promise<string> {
    const thrown = await land(treeRoot).then(
        (): Error | null => null,
        (err: unknown): Error => toError(err));
    expect(thrown).toBeInstanceOf(InformAiError);
    return thrown?.message ?? '';
}

// Simulate what `wp-finish-upsert-pr` left behind, from `treeRoot`. (MergeBodyFiler's own spec proves
// this is the shape finish really writes.)
function finishRanIn(treeRoot: string): void {
    const origin = new PrBodyOrigin();
    origin.treeRoot = treeRoot;
    origin.primaryRoot = treeRoot;
    origin.branch = BRANCH;
    origin.feature = 'dean-feature';
    origin.prNumber = '604';
    origin.prUrl = 'https://github.com/acme/widgets/pull/604';
    origin.writtenAt = new Date().toISOString();
    expect(new PrBodyStore(new MachineStateHome()).write(treeRoot, '604', GATED_BODY, origin)).not.toBeNull();
}

function landedBody(): string {
    return fs.existsSync(ghBodyCapture) ? fs.readFileSync(ghBodyCapture, 'utf8') : '';
}

function fallback(): LandPrOptions {
    const opts = new LandPrOptions();
    opts.fallbackTitleOnly = true;
    return opts;
}

beforeEach((): void => {
    savedCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-land-pr-'));
    stateHome = path.join(tmp, 'state');
    process.env[WEBPIECES_STATE_HOME_ENV] = stateHome;
    ghLog = path.join(tmp, 'gh.log');
    ghBodyCapture = path.join(tmp, 'landed-body.md');
    installFakeGh();
    primary = makeClone('primary');
});

afterEach((): void => {
    process.chdir(savedCwd);
    if (savedPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = savedPath;
    if (savedOverride === undefined) delete process.env[WEBPIECES_STATE_HOME_ENV];
    else process.env[WEBPIECES_STATE_HOME_ENV] = savedOverride;
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('wp-land-pr — the gated body is found by the PR, not by the tree', () => {
    it('lands from the same clone with the EXACT bytes finish produced', async (): Promise<void> => {
        finishRanIn(primary);

        const out = await land(primary);

        expect(landedBody()).toBe(GATED_BODY);
        expect(out).toContain('Landing PR #604');
        expect(out).toContain('Landed');
    });

    // The incident, reproduced: finish in the primary clone, land from a linked worktree.
    it('lands from a LINKED WORKTREE that did not render the body', async (): Promise<void> => {
        finishRanIn(primary);
        const worktree = path.join(tmp, 'wt-a');
        git(primary, 'worktree', 'add', '-q', '--detach', worktree);
        // Move the branch into the worktree — git forbids two trees holding it, which is exactly why a
        // per-tree home for a per-branch artifact could never be right.
        git(primary, 'checkout', '-q', 'main');
        git(worktree, 'checkout', '-q', BRANCH);
        writeConfig(worktree);

        await land(worktree);

        expect(landedBody()).toBe(GATED_BODY);
    });

    // The stronger claim: a completely different clone of the same repo on this machine.
    it('lands from a DIFFERENT CLONE of the same repo, and declines that clone\'s bookkeeping', async (): Promise<void> => {
        finishRanIn(primary);
        const second = makeClone('second-clone');

        const out = await land(second);

        expect(landedBody()).toBe(GATED_BODY);
        expect(out).toContain('Archive + worktree cleanup SKIPPED');
        expect(out).toContain(primary);
        // The wrong-objects rail: no archive tag was created in the clone that does not own the branch.
        expect(git(second, 'tag', '--list', 'archive/*')).toBe('');
    });

    it('DOES archive when the landing tree is the one that posted the PR', async (): Promise<void> => {
        finishRanIn(primary);

        const out = await land(primary);

        expect(out).not.toContain('SKIPPED');
        expect(git(primary, 'tag', '--list', 'archive/*')).toContain(`/${BRANCH}`);
    });
});

describe('wp-land-pr — nothing on this machine', () => {
    it('refuses clearly, names the machine, and does NOT merge', async (): Promise<void> => {
        const message = await refusalMessage(primary);

        expect(message).toContain('PR #604 was not found on this machine');
        expect(message).toContain('wp-finish-upsert-pr');
        expect(message).toContain('--fallback-title-only');
        expect(fs.readFileSync(ghLog, 'utf8')).not.toContain('pr merge');
        expect(landedBody()).toBe('');
    });

    it('signposts a body left by an OLDER release, loudly, and still does not read it', async (): Promise<void> => {
        const legacy = path.join(primary, '.webpieces', 'pr-review', 'dean-feature');
        fs.mkdirSync(legacy, { recursive: true });
        fs.writeFileSync(path.join(legacy, 'merge-commit-body.md'), 'STALE BODY FROM THE OLD LOCATION\n');

        const message = await refusalMessage(primary);

        expect(message).toContain('OLDER webpieces release');
        expect(message).toContain(path.join(legacy, 'merge-commit-body.md'));
        expect(landedBody()).toBe('');
    });
});

describe('wp-land-pr --fallback-title-only', () => {
    it('lands with the PR title + link, and NEVER the PR description', async (): Promise<void> => {
        const out = await land(primary, fallback());

        const body = landedBody();
        expect(body).toContain('https://github.com/acme/widgets/pull/604');
        expect(body).toContain('FALLBACK COMMIT BODY');
        // The whole reason the description was rejected as a fallback source: a PR Gate Dashboard in a
        // squash commit is the ugly git log this mechanism exists to prevent.
        expect(body).not.toContain(PR_DESCRIPTION_MARKER);
        expect(out).toContain('--fallback-title-only');
    });

    it('is the ONLY way past a missing body — the flag is required, never inferred', async (): Promise<void> => {
        expect(await refusalMessage(primary)).toContain('not found on this machine');
        expect(await land(primary, fallback())).toContain('Landed');
    });

    it('is NOT used when a gated body exists — the gated bytes always win', async (): Promise<void> => {
        finishRanIn(primary);

        await land(primary, fallback());

        expect(landedBody()).toBe(GATED_BODY);
        expect(landedBody()).not.toContain('FALLBACK');
    });
});
