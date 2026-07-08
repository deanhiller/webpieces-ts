import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    BranchMutationEvent,
    branchMutationLogPath,
    logBranchMutation,
} from './branch-mutation-log';

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'bml-'));
}

describe('branch-mutation-log', () => {
    let root: string;
    beforeEach(() => { root = tmpRoot(); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('writes to .webpieces/hooks/branch-mutations.log', () => {
        logBranchMutation(root, new BranchMutationEvent('wp-start-update', 'START'));
        const logPath = branchMutationLogPath(root);
        expect(logPath.endsWith(path.join('.webpieces', 'hooks', 'branch-mutations.log'))).toBe(true);
        expect(fs.existsSync(logPath)).toBe(true);
        const line = fs.readFileSync(logPath, 'utf8');
        expect(line).toContain('wp-start-update');
        expect(line).toContain('START');
    });

    it('renders only the fields the event set (RENAME → from/to)', () => {
        const event = new BranchMutationEvent('wp-finish-update', 'RENAME');
        event.fromBranch = 'dean/x';
        event.toBranch = 'dean/xwp2';
        logBranchMutation(root, event);
        const line = fs.readFileSync(branchMutationLogPath(root), 'utf8');
        expect(line).toContain('from=dean/x to=dean/xwp2');
        expect(line).not.toContain('oldMain'); // not set → not rendered
    });

    it('renders oldMain→newMain for a PULL and conflict details for a CONFLICT', () => {
        const pull = new BranchMutationEvent('wp-start-upsert-pr', 'PULL');
        pull.oldMain = 'aaaaaaa';
        pull.newMain = 'bbbbbbb';
        logBranchMutation(root, pull);

        const conflict = new BranchMutationEvent('wp-start-upsert-pr', 'CONFLICT');
        conflict.conflict = true;
        conflict.conflictFiles = ['src/a.ts', 'src/b.ts'];
        conflict.artifacts = ['.webpieces/merge/x'];
        logBranchMutation(root, conflict);

        const log = fs.readFileSync(branchMutationLogPath(root), 'utf8');
        expect(log).toContain('oldMain=aaaaaaa newMain=bbbbbbb');
        expect(log).toContain('conflict=true');
        expect(log).toContain('conflictFiles=2(src/a.ts,src/b.ts)');
        expect(log).toContain('artifact=.webpieces/merge/x');
    });

    it('appends one line per event and collapses newlines to keep events single-line', () => {
        const end = new BranchMutationEvent('wp-finish-upsert-pr', 'END');
        end.outcome = 'finalized';
        logBranchMutation(root, end);
        logBranchMutation(root, new BranchMutationEvent('wp-finish-upsert-pr', 'START'));
        const lines = fs.readFileSync(branchMutationLogPath(root), 'utf8').trimEnd().split('\n');
        expect(lines.length).toBe(2);
        expect(lines[0]).toContain('outcome=finalized');
    });

    it('never throws even if the root is unwritable (best-effort logging)', () => {
        // A path that cannot be created (a file where a dir is expected) must be swallowed.
        const filePath = path.join(root, 'not-a-dir');
        fs.writeFileSync(filePath, 'x');
        expect(() => logBranchMutation(filePath, new BranchMutationEvent('wp-start-update', 'START'))).not.toThrow();
    });
});
