import { describe, expect, it } from 'vitest';
import { BranchIdentity } from '@webpieces/repo-workflow-core';
import { CliExitError } from '@webpieces/rules-config';
import { HotfixRedirect } from './hotfix-redirect';

class FixedBranch extends BranchIdentity {
    constructor(private readonly branch: string) {
        super();
    }

    override current(): string {
        return this.branch;
    }
}

const STAGES = ['wp-start-upsert-pr', 'wp-review-upsert-pr', 'wp-finish-upsert-pr'];

describe('HotfixRedirect (issue #1057)', () => {
    it('sends every PR stage on a /hotfix/ branch to wp-upsert-hotfix-pr, before anything runs', () => {
        const redirect = new HotfixRedirect(new FixedBranch('dean/1057/hotfix/fix-timeout'));
        for (const stage of STAGES) {
            const run = (): void => redirect.assertNotHotfix(stage);
            expect(run).toThrowError(CliExitError);
            expect(run).toThrowError(/pnpm wp-upsert-hotfix-pr/);
            expect(run).toThrowError(new RegExp(`${stage} does not run on a /hotfix/ branch`));
            expect(run).toThrowError(/Nothing was changed/);
        }
    });

    it('names none of the deleted two-step hotfix flow', () => {
        const message = new HotfixRedirect(new FixedBranch('dean/hotfix/x')).message('wp-start-upsert-pr', 'dean/hotfix/x');
        expect(message).not.toContain('pnpm wp-finish-upsert-pr');
        expect(message).not.toContain('pnpm wp-review-upsert-pr');
    });

    it('stays silent on a normal branch and on lookalike names', () => {
        for (const branch of ['dean/feature', 'dean/Hotfix/x', 'dean/hotfix-x', 'hotfix/x']) {
            const redirect = new HotfixRedirect(new FixedBranch(branch));
            for (const stage of STAGES) expect((): void => redirect.assertNotHotfix(stage)).not.toThrow();
        }
    });
});
