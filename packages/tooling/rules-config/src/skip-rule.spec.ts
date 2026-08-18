import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { RuleFailError } from './rule-fail-error';
import { shouldSkipRule, SkipRuleResult } from './skip-rule';
import { toError } from './to-error';

// What `git rev-parse --abbrev-ref HEAD` reports. "HEAD" is what a real detached CI checkout of
// refs/pull/<N>/merge returns — the exact condition this suite pins.
const state = vi.hoisted(() => ({ branch: 'main' }));

vi.mock('child_process', () => ({
    execSync: (): string => `${state.branch}\n`,
}));

describe('shouldSkipRule branch hatch in a detached checkout', () => {
    beforeEach(() => {
        state.branch = 'HEAD';
        delete process.env.GITHUB_HEAD_REF;
        delete process.env.WEBPIECES_BRANCH;
        // The fork gate keys off these three; a leftover from the suite below would make every case
        // here throw a fork refusal instead of exercising the branch it is about.
        delete process.env.GITHUB_EVENT_NAME;
        delete process.env.GITHUB_EVENT_PATH;
        delete process.env.GITHUB_REPOSITORY;
    });

    it('honors the hatch from GITHUB_HEAD_REF when git only reports "HEAD"', () => {
        process.env.GITHUB_HEAD_REF = 'rename-fuse-to-theme';

        expect(shouldSkipRule(undefined, 'rename-fuse-to-theme'))
            .toEqual(new SkipRuleResult(true, 'on branch "rename-fuse-to-theme"'));
    });

    it('honors the hatch from WEBPIECES_BRANCH on CI systems without GITHUB_HEAD_REF', () => {
        process.env.WEBPIECES_BRANCH = 'rename-fuse-to-theme';

        expect(shouldSkipRule(undefined, 'rename-fuse-to-theme').skip).toBe(true);
    });

    // ENFORCES when a hatch is configured but there is no branch to match it against, and carries WHY on
    // the returned value. The hatch relaxes a rule while you EDIT on a branch; a tag checkout or a bisect
    // step is not editing, so the rule simply runs and whoever trips it gets that rule's own message and
    // cure. It used to THROW a hatch-specific error here, which told a bisecting developer about escape
    // hatches instead. The reason is DATA, not a log line: a console write from a library cannot be
    // caught, re-rendered per audience, or asserted on.
    it('ENFORCES the rule when no branch can be resolved, and says why on the result', () => {
        const result = shouldSkipRule(undefined, 'rename-fuse-to-theme');

        expect(result.skip).toBe(false);
        expect(result.reason).toBe('');
        expect(result.hatchNotApplied).toMatch(/HEAD is detached/);
        expect(result.hatchNotApplied).toContain('rename-fuse-to-theme');
    });

    // Nothing to say when the hatch DID apply, or when there is no hatch at all.
    it('leaves hatchNotApplied empty when the hatch applies', () => {
        process.env.GITHUB_HEAD_REF = 'rename-fuse-to-theme';

        expect(shouldSkipRule(undefined, 'rename-fuse-to-theme').hatchNotApplied).toBe('');
        expect(shouldSkipRule(undefined, null).hatchNotApplied).toBe('');
    });

    // The property that protects the ~all configs that never opted in: detached + null stays silent.
    it('stays silent with branchName null, even detached', () => {
        expect(shouldSkipRule(undefined, null).skip).toBe(false);
        expect(shouldSkipRule(undefined, undefined).skip).toBe(false);
    });

    it('still evaluates the epoch hatch when branchName is null and HEAD is detached', () => {
        const future = Date.now() / 1000 + 86400;

        expect(shouldSkipRule(future, null).skip).toBe(true);
    });

    it('does not consult env vars when git can name the branch', () => {
        state.branch = 'feature-a';
        process.env.GITHUB_HEAD_REF = '';

        expect(shouldSkipRule(undefined, 'feature-a').skip).toBe(true);
    });
});

describe('shouldSkipRule branch hatch is an EXACT name, never a pattern', () => {
    beforeEach(() => {
        state.branch = 'dean/refactor-widgets';
        delete process.env.GITHUB_HEAD_REF;
        delete process.env.WEBPIECES_BRANCH;
        delete process.env.GITHUB_EVENT_NAME;
        delete process.env.GITHUB_EVENT_PATH;
        delete process.env.GITHUB_REPOSITORY;
    });

    // The parameter used to be called branchPattern, which advertises a capability the `===` below has
    // never had. A glob validates fine, matches nothing, and the rule silently stays ON. Pinned so the
    // name and the comparison can never drift apart again.
    it('does NOT treat a glob as a pattern — it stays on', () => {
        expect(shouldSkipRule(undefined, 'dean/refactor-*').skip).toBe(false);
    });

    it('skips only on the exact name', () => {
        expect(shouldSkipRule(undefined, 'dean/refactor-widgets').skip).toBe(true);
    });
});

describe('shouldSkipRule refuses to honor a hatch on a fork pull request', () => {
    const HATCH = 'dean/big-refactor';
    let eventPath = '';

    beforeEach(() => {
        state.branch = 'HEAD';
        delete process.env.WEBPIECES_BRANCH;
        // Exactly what a GitHub runner sets on a pull_request: the HEAD branch name, which on a fork PR
        // is a string the outside contributor chose.
        process.env.GITHUB_HEAD_REF = HATCH;
        process.env.GITHUB_REPOSITORY = 'ctoteachings/monorepo';
        process.env.GITHUB_EVENT_NAME = 'pull_request';
        eventPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-event-')), 'event.json');
        process.env.GITHUB_EVENT_PATH = eventPath;
    });

    afterEach(() => {
        fs.rmSync(path.dirname(eventPath), { recursive: true, force: true });
        delete process.env.GITHUB_HEAD_REF;
        delete process.env.GITHUB_EVENT_NAME;
        delete process.env.GITHUB_EVENT_PATH;
        delete process.env.GITHUB_REPOSITORY;
    });

    function writeEvent(headRepoFullName: string): void {
        fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { head: { repo: { full_name: headRepoFullName } } } }));
    }

    // THE HOLE: hatch names ship in a committed, public webpieces.config.json, so an outside contributor
    // can name their branch after one and turn that rule off on their own PR.
    it('THROWS on a pull_request whose head branch lives in a fork', () => {
        writeEvent('outsider/monorepo');

        expect(() => shouldSkipRule(undefined, HATCH)).toThrow(/PULL REQUEST AUTHOR/);
    });

    // The cures are STRUCTURED (RuleFailError.fixHints), so the framework owns their labelling — a
    // hand-numbered "WORKAROUNDS: 1. … 2. …" literal is what this replaced.
    it('carries its cures as fixHints, not as a hand-numbered string', () => {
        writeEvent('outsider/monorepo');

        let thrown: RuleFailError | null = null;
        // webpieces-disable no-unmanaged-exceptions -- the assertion IS on the thrown value's shape
        try {
            shouldSkipRule(undefined, HATCH);
        } catch (err: unknown) {
            const error = toError(err);
            thrown = error instanceof RuleFailError ? error : null;
        }

        expect(thrown).toBeInstanceOf(RuleFailError);
        expect(thrown?.ruleName).toBe('turnOffRuleWhileOnBranch');
        expect(thrown?.fixHints.length).toBe(2);
        expect(thrown?.aiMessage).not.toMatch(/\n\s*[12]\./);
    });

    it('honors the hatch on a pull_request from a branch of THIS repo', () => {
        writeEvent('ctoteachings/monorepo');

        const result = shouldSkipRule(undefined, HATCH);

        expect(result.skip).toBe(true);
        expect(result.reason).toBe(`on branch "${HATCH}"`);
    });

    // pull_request_target runs with the BASE repo's secrets against contributor code — untrusted with no
    // comparison to make, so the event file is never even consulted.
    it('THROWS on pull_request_target regardless of the head repo', () => {
        writeEvent('ctoteachings/monorepo');
        process.env.GITHUB_EVENT_NAME = 'pull_request_target';

        expect(() => shouldSkipRule(undefined, HATCH)).toThrow(/pull_request_target/);
    });

    // "Cannot prove it is ours" is untrusted, same as a fork.
    it('THROWS when the event file is missing so ownership cannot be proven', () => {
        fs.rmSync(eventPath, { force: true });

        expect(() => shouldSkipRule(undefined, HATCH)).toThrow(/no readable \$GITHUB_EVENT_PATH/);
    });

    // The property that protects every repo that never opted in: with no hatch configured a fork PR is
    // an ordinary run and NOTHING here fires.
    it('stays silent on a fork PR when no branch hatch is configured', () => {
        writeEvent('outsider/monorepo');

        expect(shouldSkipRule(undefined, null).skip).toBe(false);
        expect(shouldSkipRule(undefined, undefined).skip).toBe(false);
    });

    // The epoch hatch is TIME based — it cannot be self-granted by naming a branch, so a fork PR must
    // still honor it.
    it('still honors turnOffRuleUntilEpoch on a fork PR', () => {
        writeEvent('outsider/monorepo');

        expect(shouldSkipRule(Date.now() / 1000 + 86400, null).skip).toBe(true);
    });
});
