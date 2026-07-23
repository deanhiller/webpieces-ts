import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    WEBPIECES_TMP_DIR,
    MERGE_INFO_DIR,
    MERGE_IN_PROGRESS_FILE,
    PrCreationOrPushGuardConfig,
    MergeInProgressGuardConfig,
    allRuleNames,
} from '@webpieces/rules-config';
import type { BashContext } from '../types';
import { PrCreationOrPushGuardRule } from './pr-creation-or-push-guard';
import { MergeInProgressGuardRule } from './merge-in-progress-guard';
import { builtInRuleNames } from './index';

const prCreationOrPushGuard = new PrCreationOrPushGuardRule(new PrCreationOrPushGuardConfig());
const mergeInProgressGuard = new MergeInProgressGuardRule(new MergeInProgressGuardConfig());

function ctx(command: string, workspaceRoot: string): BashContext {
    return { command, workspaceRoot, options: {} } as BashContext;
}

// A real temp root: a blocking guard now WRITES the git-workflow doc it links to, so the root must be
// a directory we own rather than a made-up path.
function tempRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-guards-'));
}

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
    function withMarker(validated: boolean): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-guard-'));
        const dir = path.join(root, WEBPIECES_TMP_DIR, MERGE_INFO_DIR, 'feat');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, MERGE_IN_PROGRESS_FILE), JSON.stringify({ validated }));
        return root;
    }

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

// The runtime-side twin of rules-config's registry-consistency test. A name in builtInRuleNames loads
// at runtime and makes config-sync DEMAND a config entry for it — but validation accepts that entry
// only if the name is also in RULE_SCHEMAS (allRuleNames). A name in one list but not the other is the
// exact deadlock read-stale-guard (then named main-stale-guard) shipped with in 0.4.415. Lock them
// together here too.
describe('built-in rule registry is validatable', () => {
    it('every built-in rule name has a schema (allRuleNames), so its config entry can be validated and seeded', () => {
        const schema = new Set(allRuleNames());
        const missing = builtInRuleNames.filter((name: string): boolean => !schema.has(name));
        expect(missing).toEqual([]);
    });
});
