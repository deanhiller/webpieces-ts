import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    WEBPIECES_TMP_DIR,
    MERGE_INFO_DIR,
    MERGE_IN_PROGRESS_FILE,
    PrCreationGuardConfig,
    MergeInProgressGuardConfig,
} from '@webpieces/rules-config';
import type { BashContext } from '../types';
import { PrCreationGuardRule } from './pr-creation-guard';
import { MergeInProgressGuardRule } from './merge-in-progress-guard';

const prCreationGuard = new PrCreationGuardRule(new PrCreationGuardConfig());
const mergeInProgressGuard = new MergeInProgressGuardRule(new MergeInProgressGuardConfig());

function ctx(command: string, workspaceRoot: string): BashContext {
    return { command, workspaceRoot, options: {} } as BashContext;
}

describe('pr-creation-guard', () => {
    it('blocks direct PR creation paths, allows read-only and the gated command', () => {
        const root = '/tmp/x';
        expect(prCreationGuard.check(ctx('gh pr create --title x', root)).length).toBe(1);
        expect(prCreationGuard.check(ctx('gh api repos/o/r/pulls -f title=x', root)).length).toBe(1);
        expect(prCreationGuard.check(ctx('gh pr list', root)).length).toBe(0);
        expect(prCreationGuard.check(ctx('pnpm wp-finish-upsert-pr', root)).length).toBe(0);
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

    it('allows everything once the marker is validated', () => {
        const root = withMarker(true);
        expect(mergeInProgressGuard.check(ctx('git commit -m x', root)).length).toBe(0);
    });

    it('allows everything when no merge is in progress', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-guard-'));
        expect(mergeInProgressGuard.check(ctx('git commit -m x', root)).length).toBe(0);
    });
});
