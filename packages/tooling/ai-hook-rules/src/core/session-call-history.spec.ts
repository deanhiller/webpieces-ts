import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach } from 'vitest';
import { dotWebpieces } from '@webpieces/rules-config';

import { CALLS_STREAM } from './log-streams';
import { logStream, StreamIdentity } from './log-stream';
import { logTarget, MAX_TARGET_LEN } from './log-target';
import { SessionCallHistory } from './session-call-history';

let root = '';

beforeEach((): void => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'call-history-'));
    logStream.identify(new StreamIdentity('sess-1', 'agent-1', 'guards'));
});

/**
 * One logged call, in `InvocationLog.finish`'s own field order: timestamp, tool, target, then the rest.
 * Written through the SAME path resolution the reader uses, so the test asserts the parsing rather than
 * re-deriving the layout — the layout has its own spec in log-layout.spec.ts.
 */
function logCall(tool: string, command: string): void {
    const dir = dotWebpieces.logsFile(root, CALLS_STREAM);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
        path.join(dir, logStream.writerFile('.log')),
        [`[${new Date().toISOString()}]`, tool, logTarget.oneLine(command), 'branch=main', 'sync=none'].join('\t') + '\n');
}

describe('SessionCallHistory counts identical prior Bash calls in this session', () => {
    it('counts nothing before anything has been logged', () => {
        expect(new SessionCallHistory().priorBashCalls(root, 'gh pr checks 874')).toBe(0);
    });

    it('counts each identical prior call', () => {
        logCall('Bash', 'gh pr checks 874');
        logCall('Bash', 'gh pr checks 874');
        expect(new SessionCallHistory().priorBashCalls(root, 'gh pr checks 874')).toBe(2);
    });

    // Matching the TARGET FIELD, not the line: a command that merely mentions another command in its
    // text would otherwise be counted as that command.
    it('does not count a different command, or the same text under a different tool', () => {
        logCall('Bash', 'gh pr checks 875');
        logCall('Bash', 'echo "gh pr checks 874"');
        logCall('Read', 'gh pr checks 874');
        expect(new SessionCallHistory().priorBashCalls(root, 'gh pr checks 874')).toBe(0);
    });

    it('matches a multi-line command against the one-lined form the log stores', () => {
        logCall('Bash', 'gh pr checks 874');
        expect(new SessionCallHistory().priorBashCalls(root, '  gh pr checks\t874  ')).toBe(1);
    });

    /**
     * The read and the write share ONE normalizer (LogTarget) precisely so a long command still matches
     * itself. Two private copies of the cap is the silent second spelling that would break this.
     */
    it('matches a command long enough to be truncated in the log', () => {
        const long = `gh pr view 874 --json ${'x'.repeat(MAX_TARGET_LEN)}`;
        logCall('Bash', long);
        expect(new SessionCallHistory().priorBashCalls(root, long)).toBe(1);
    });

    // No evidence is 0, never an error: a logging failure may never become a refusal.
    it('fails open on a root that does not exist', () => {
        expect(new SessionCallHistory().priorBashCalls(path.join(root, 'gone'), 'gh pr checks 874')).toBe(0);
    });
});
