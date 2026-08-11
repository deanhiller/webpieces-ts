import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WEBPIECES_TMP_DIR, MERGE_INFO_DIR, MERGE_IN_PROGRESS_FILE, PrLifecycleGuardConfig, DEFAULT_UPSERT_PR_COMMAND, DEFAULT_MERGE_COMPLETE_COMMAND, allRuleNames } from '@webpieces/rules-config';
import { BashContext } from '../types';
import { PrCreationOrPushGuardRule } from './pr-creation-or-push-guard';
import { MergeInProgressGuardRule } from './merge-in-progress-guard';
import { builtInConfigKeys } from './index';

// The gated-command strings are handed in by the LOADER now, not read off the guard's config entry
// (that field was a second spelling of commands.guardHints and beat it at the point of use). Tests
// construct with the same defaults buildCommandsConfig resolves to when a repo configures nothing.
const prCreationOrPushGuard = new PrCreationOrPushGuardRule(new PrLifecycleGuardConfig(), DEFAULT_UPSERT_PR_COMMAND);
const mergeInProgressGuard = new MergeInProgressGuardRule(new PrLifecycleGuardConfig(), DEFAULT_MERGE_COMPLETE_COMMAND);

function ctx(command: string, workspaceRoot: string): BashContext {
    return new BashContext(command, workspaceRoot);
}

// A real temp root: a blocking guard now WRITES the git-workflow doc it links to, so the root must be
// a directory we own rather than a made-up path.
function tempRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-guards-'));
}

// A workspace root carrying a merge marker, so merge-in-progress-guard sees a merge in flight.
function withMarkerRoot(validated: boolean): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-guard-'));
    const dir = path.join(root, WEBPIECES_TMP_DIR, MERGE_INFO_DIR, 'feat');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MERGE_IN_PROGRESS_FILE), JSON.stringify({ validated }));
    return root;
}

describe('pr-creation-or-push-guard matches code, not prose about code', () => {
    // End-to-end proof for the guard whose `\bgit\s+push\b` pattern fires on the most ordinary English
    // in a repo whose subject matter IS the git workflow. Stripping lives in BashContext.commandCode.
    it('does not block a commit message that merely mentions the blocked commands', () => {
        const root = tempRoot();
        expect(prCreationOrPushGuard.check(ctx('git commit -m "document why git push is blocked"', root)).length).toBe(0);
        expect(prCreationOrPushGuard.check(ctx("git commit -F - <<'EOF'\nwe now block gh pr create\nEOF", root)).length).toBe(0);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('still blocks the real commands', () => {
        const root = tempRoot();
        expect(prCreationOrPushGuard.check(ctx('git push origin HEAD', root)).length).toBe(1);
        expect(prCreationOrPushGuard.check(ctx('gh pr create --title x', root)).length).toBe(1);
        fs.rmSync(root, { recursive: true, force: true });
    });
});

describe('pr-creation-or-push-guard', () => {
    it('writes the git-workflow doc it points the AI at (it may not exist yet)', () => {
        const root = tempRoot();
        const doc = path.join(root, WEBPIECES_TMP_DIR, 'instruct-ai', 'webpieces.git-workflow.md');
        expect(fs.existsSync(doc)).toBe(false);

        const violations = prCreationOrPushGuard.check(ctx('gh pr create --title x', root));
        expect(violations.length).toBe(1);
        expect(fs.existsSync(doc)).toBe(true);
        // And the message points at exactly that file.
        expect(violations[0].message).toContain(doc);

        // A STALE copy is as misleading as a missing one — the guard overwrites, not writes-if-missing.
        fs.writeFileSync(doc, 'stale content from an older @webpieces');
        prCreationOrPushGuard.check(ctx('gh pr create --title x', root));
        expect(fs.readFileSync(doc, 'utf8')).not.toContain('stale content');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('blocks direct PR creation paths, allows read-only and the gated command', () => {
        const root = tempRoot();
        expect(prCreationOrPushGuard.check(ctx('gh pr create --title x', root)).length).toBe(1);
        expect(prCreationOrPushGuard.check(ctx('gh api repos/o/r/pulls -f title=x', root)).length).toBe(1);
        expect(prCreationOrPushGuard.check(ctx('gh pr list', root)).length).toBe(0);
        expect(prCreationOrPushGuard.check(ctx('pnpm wp-finish-upsert-pr', root)).length).toBe(0);
    });

    it('blocks a manual git push, but not the gated commands or other git reads', () => {
        const root = tempRoot();
        expect(prCreationOrPushGuard.check(ctx('git push origin HEAD', root)).length).toBe(1);
        expect(prCreationOrPushGuard.check(ctx('git push -u origin base', root)).length).toBe(1);
        expect(prCreationOrPushGuard.check(ctx('git push --force-with-lease', root)).length).toBe(1);
        // The gated flow pushes internally as a child process — its own invocation string has no push.
        expect(prCreationOrPushGuard.check(ctx('pnpm wp-start-upsert-pr', root)).length).toBe(0);
        expect(prCreationOrPushGuard.check(ctx('git status', root)).length).toBe(0);
        expect(prCreationOrPushGuard.check(ctx('git log --oneline -5', root)).length).toBe(0);
    });
});

describe('merge-in-progress-guard', () => {
    const withMarker = withMarkerRoot;

    it('blocks commit/push while an unvalidated marker exists', () => {
        const root = withMarker(false);
        expect(mergeInProgressGuard.check(ctx('git commit -m x', root)).length).toBe(1);
        expect(mergeInProgressGuard.check(ctx('git push origin HEAD', root)).length).toBe(1);
        expect(mergeInProgressGuard.check(ctx('pnpm wp-finish-upsert-pr', root)).length).toBe(0);
    });

    it('does not mistake read-only `git merge-base` for `git merge`', () => {
        // `\bgit\s+merge\b` matched merge-base (the \b sits between `e` and `-`), so an in-progress
        // merge blocked the diff-scope lookup in this repo's own documented build command.
        const root = withMarker(false);
        expect(mergeInProgressGuard.check(ctx('git merge-base origin/main HEAD', root)).length).toBe(0);
        expect(mergeInProgressGuard.check(ctx('pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)', root)).length).toBe(0);
        // ...but a real merge is still blocked.
        expect(mergeInProgressGuard.check(ctx('git merge main', root)).length).toBe(1);
    });

    it('allows everything once the marker is validated', () => {
        const root = withMarker(true);
        expect(mergeInProgressGuard.check(ctx('git commit -m x', root)).length).toBe(0);
    });

    it('allows everything when no merge is in progress', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-guard-'));
        expect(mergeInProgressGuard.check(ctx('git commit -m x', root)).length).toBe(0);
    });
});

// The fixHint is the ONLY thing an agent sees when this guard fires, and it used to say "do not run
// other commands" — unbounded, and therefore a claim that the reads, the `git add`, the build and the
// tests that finishing a merge REQUIRES were all forbidden. It said so inside an "Add to memory"
// directive, so an agent that obeyed carried the falsehood into later sessions and other repos. These
// tests pin the hint to the truth: name the blocked commands, name what is expected, and keep the only
// memorized sentence to something that stays true at any version.
describe('merge-in-progress-guard fixHint tells the truth about what is blocked', () => {
    const hint = mergeInProgressGuard.fixHint.mainMessage;

    it('names every command the guard actually blocks', () => {
        for (const cmd of ['`git commit`', '`git push`', '`git merge`', '`git rebase`', '`gh pr create|edit|merge`']) {
            expect(hint).toContain(cmd);
        }
    });

    it('makes no unbounded claim about "other commands"', () => {
        expect(hint).not.toContain('other commands');
        expect(hint.toLowerCase()).not.toContain('do not run other');
    });

    it('states what IS expected during a merge, including the things the finish gate demands', () => {
        // merge-end hard-fails with "Git still reports unmerged files … Resolve and `git add` them",
        // so a hint that discourages `git add` contradicts the guard's own paired tool.
        expect(hint).toContain('`git add`');
        expect(hint).toContain('NOT blocked');
        expect(hint).toContain('build');
    });

    it('only asks the agent to memorize a version-stable fact — never the blocked list', () => {
        const memoryLines = hint.split('\n').filter((line: string): boolean => line.includes('Add to memory'));
        expect(memoryLines.length).toBe(1);
        const memorized = memoryLines[0];
        // A memorized sentence outlives the code. It must not name a command, a version, a config key
        // or a repo-specific path, because none of those are stable across sessions.
        expect(memorized).toBe('Add to memory: finish a started merge before beginning other work.');
        expect(memorized).not.toMatch(/git |gh |pnpm |wp-/);
    });

    it('derives the blocked list from the enforcement itself, so hint and code cannot drift', () => {
        // Anything the hint names must genuinely be blocked, proven through check() rather than by
        // re-reading the same constant the hint used.
        const root = withMarkerRoot(false);
        for (const cmd of ['git commit -m x', 'git push', 'git merge main', 'git rebase main', 'gh pr create', 'gh pr edit 1', 'gh pr merge 1']) {
            expect(mergeInProgressGuard.check(ctx(cmd, root)).length).toBe(1);
        }
        // ...and everything the hint says is expected must genuinely run.
        for (const cmd of ['git add src/foo.ts', 'git status', 'git diff', 'pnpm run build-all', 'cat src/foo.ts']) {
            expect(mergeInProgressGuard.check(ctx(cmd, root)).length).toBe(0);
        }
    });
});

// The runtime-side twin of rules-config's registry-consistency test. A name in builtInConfigKeys loads
// at runtime and makes config-sync DEMAND a config entry for it — but validation accepts that entry
// only if the name is also in RULE_SCHEMAS (allRuleNames). A name in one list but not the other is the
// exact deadlock read-stale-guard (then named main-stale-guard) shipped with in 0.4.415. Lock them
// together here too.
describe('built-in rule registry is validatable', () => {
    it('every built-in rule name has a schema (allRuleNames), so its config entry can be validated and seeded', () => {
        const schema = new Set(allRuleNames());
        const missing = builtInConfigKeys.filter((name: string): boolean => !schema.has(name));
        expect(missing).toEqual([]);
    });
});

/**
 * Acceptance criterion 9 of the dev-deploy feature: a blocked push whose REFSPEC targets the dev
 * namespace or the dev branch surfaces the `wp-push-dev` remedy, not the `wp-start-upsert-pr` one.
 *
 * This is the half that makes the feature exist at all rather than being polish. An AI told "put my
 * branch on dev" tries `git push`, gets blocked, and does whatever the hint says. With one flat hint it
 * opens a PR to main — the opposite of what it was asked, and the destructive direction of the two.
 */
describe('pr-creation-or-push-guard steers by the destination of the blocked push', () => {
    function messageFor(command: string): string {
        const root = tempRoot();
        const violations = prCreationOrPushGuard.check(ctx(command, root));
        expect(violations.length).toBe(1);
        const message = violations[0].message ?? '';
        fs.rmSync(root, { recursive: true, force: true });
        return message;
    }

    it('offers wp-push-dev for a push into the dev namespace', () => {
        const message = messageFor('git push origin HEAD:dev-include/dean/ONE-2275');
        expect(message).toContain('pnpm wp-push-dev');
        expect(message).toContain('Do NOT use pnpm wp-start-upsert-pr');
    });

    it('offers wp-push-dev for a push at the dev branch itself, in either refspec form', () => {
        expect(messageFor('git push origin dev')).toContain('pnpm wp-push-dev');
        expect(messageFor('git push origin HEAD:dev')).toContain('pnpm wp-push-dev');
        expect(messageFor('git push origin HEAD:refs/heads/dev')).toContain('pnpm wp-push-dev');
    });

    it('keeps the PR-flow remedy for every other push', () => {
        const message = messageFor('git push origin HEAD');
        expect(message).toContain('pnpm wp-start-upsert-pr');
        expect(message).not.toContain('wp-push-dev');
    });

    it('does not mistake a branch merely NAMED like the dev branch for the dev branch', () => {
        const message = messageFor('git push origin HEAD:developer-notes');
        expect(message).not.toContain('wp-push-dev');
    });

    it('names both destinations in the rule-level fix hint, so neither is invisible', () => {
        const hint = prCreationOrPushGuard.fixHint.mainMessage;
        expect(hint).toContain('pnpm wp-start-upsert-pr');
        expect(hint).toContain('pnpm wp-push-dev');
        expect(hint).toContain('LANDING ON MAIN');
        expect(hint).toContain('SHARED DEV SERVER');
    });
});
