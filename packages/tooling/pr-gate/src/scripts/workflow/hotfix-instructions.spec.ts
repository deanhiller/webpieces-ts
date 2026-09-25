import { describe, expect, it } from 'vitest';
import { HotfixInstructions } from './hotfix-instructions';

describe('HotfixInstructions', () => {
    const instructions = new HotfixInstructions();
    const summary = '/repo/.webpieces/pr-review/dean-hotfix-fix/summary.json';

    it('hands stage one directly to summary + finish without reviewers', () => {
        const text = instructions.afterStart(summary, 'Your diff: git diff abc HEAD');
        expect(text).toContain(summary);
        expect(text).toContain('pnpm wp-finish-upsert-pr');
        expect(text).not.toContain('pnpm wp-review-upsert-pr');
        expect(text).toContain('No reviewer agent runs');
    });

    it('makes an accidental review invocation an explicit no-op', () => {
        const text = instructions.reviewNoOp(summary);
        expect(text).toContain('No build, checklist scan');
        expect(text).toContain('No reviewer agent ran');
        expect(text).toContain('review receipt was produced');
        expect(text).toContain('pnpm wp-finish-upsert-pr');
    });
});
