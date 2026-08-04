import { describe, it, expect } from 'vitest';
import { DevDeployConfig } from '@webpieces/rules-config';

import { DevDeployWatchHints } from './dev-deploy-watch-hints';

/**
 * These assertions are about COPY-PASTEABILITY, not prose. The whole design bet here is that handing an
 * AI the exact commands beats webpieces trying to model somebody else's CD — and that bet only pays off
 * if every command comes out fully substituted. A template with a blank left in it is worse than no hint
 * at all: the AI fills the blank in with a plausible guess, and a wrong `git merge-base` argument answers
 * "did my code deploy?" confidently and incorrectly.
 */

const SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const hints = new DevDeployWatchHints();

function rendered(cfg: DevDeployConfig = new DevDeployConfig('dev-include', 'dev')): string {
    return hints.render(cfg, cfg.copyRefFor('dean/ONE-2275'), SHA);
}

describe('DevDeployWatchHints', () => {
    it('gives the ancestry check fully substituted — the sha, not a placeholder', () => {
        expect(rendered()).toContain(`git merge-base --is-ancestor ${SHA} origin/dev`);
        expect(rendered()).toContain('git fetch origin dev');
    });

    it('gives both gh run lookups against real branch names', () => {
        const out = rendered();
        expect(out).toContain('gh run list --branch dev-include/dean/ONE-2275 --limit 5');
        expect(out).toContain('gh run list --branch dev --limit 5');
        expect(out).toContain('gh run watch <run-id>');
    });

    it('leaves no unsubstituted placeholder except the run id the AI reads off gh', () => {
        const placeholders = rendered().match(/<[a-z-]+>/g) ?? [];
        expect(new Set(placeholders)).toEqual(new Set(['<run-id>']));
    });

    it('honours a consumer that renamed both refs', () => {
        const cfg = new DevDeployConfig('staging-include', 'staging');
        const out = rendered(cfg);
        expect(out).toContain(`git merge-base --is-ancestor ${SHA} origin/staging`);
        expect(out).toContain('gh run list --branch staging-include/dean/ONE-2275 --limit 5');
        expect(out).not.toContain('dev-include');
    });

    it('says a green run on the shared branch is not proof YOUR change deployed', () => {
        // The trap the ordering exists to prevent: `dev` carries everyone's copies, so its run status is
        // a statement about the machinery, never about one developer's code.
        expect(rendered()).toContain('is NOT proof your change deployed');
    });

    it('tells the AI that empty gh output is an answer, not a failure to retry', () => {
        expect(rendered()).toContain('Empty output is not a bug');
        expect(rendered()).toContain('do not guess');
    });
});
