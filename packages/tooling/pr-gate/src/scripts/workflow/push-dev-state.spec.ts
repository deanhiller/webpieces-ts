import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describe, it, expect, beforeEach } from 'vitest';
import { CliExitError, DotWebpieces, PUSH_DEV_STATE_FILE, toError } from '@webpieces/rules-config';

import { PushDevState, PushDevStateStore } from './push-dev-state';

/**
 * Round-trip of the resolve state file, and the refusal it powers.
 *
 * The refusal assertions are deliberately about the SHAPE of the message, not its wording: the blocked
 * command list must render from the code that enforces it. merge-in-progress-guard learned that lesson the
 * expensive way — its hand-written "do not run other commands" forbade the reads and the `git add` that
 * finishing a merge actually requires, and survived every edit to the real enforcement.
 */

const store = new PushDevStateStore(new DotWebpieces());
let repo = '';

function stateFile(): string {
    return path.join(repo, '.webpieces', PUSH_DEV_STATE_FILE);
}

// The message of the CliExitError `fn` is expected to throw.
function refusal(fn: () => void): string {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        fn();
    } catch (err: unknown) {
        const error = toError(err);
        // The assertion IS that this throws a CliExitError; its text is what the human reads.
        if (error instanceof CliExitError) return error.message;
        throw error;
    }
    return '';
}

beforeEach((): void => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-push-dev-state-'));
    fs.mkdirSync(path.join(repo, '.webpieces'), { recursive: true });
});

describe('PushDevStateStore', () => {
    it('round-trips a resolve and clears it', (): void => {
        expect(store.exists(repo)).toBe(false);
        store.write(repo, new PushDevState('dean/ONE-2275', 'tmp', 'dev-include/dean/ONE-2275', ['a', 'b'], 'a'));
        expect(store.exists(repo)).toBe(true);

        const read = store.read(repo);
        expect(read?.originalBranch).toBe('dean/ONE-2275');
        expect(read?.queue).toEqual(['a', 'b']);
        expect(read?.current).toBe('a');

        store.clear(repo);
        expect(store.read(repo)).toBeNull();
    });

    it('degrades a corrupt state file to "no resolve" rather than crashing every wp-* command', (): void => {
        fs.writeFileSync(stateFile(), '{ this is not json', 'utf8');
        expect(store.read(repo)).toBeNull();
    });

    it('treats a well-formed but incomplete file as no resolve', (): void => {
        fs.writeFileSync(stateFile(), JSON.stringify({ queue: ['a'] }), 'utf8');
        expect(store.read(repo)).toBeNull();
    });
});

describe('PushDevStateStore — refusing other wp-* commands mid-resolve', () => {
    beforeEach((): void => {
        store.write(repo, new PushDevState('dean/ONE-2275', 'dean/ONE-2275DevResolve', 'dev-include/dean/ONE-2275', []));
    });

    it('names every blocked command, and says that is the whole list', (): void => {
        const message = refusal((): void => { store.assertIdle(repo, 'wp-start-upsert-pr'); });
        for (const command of ['wp-start-update', 'wp-finish-update', 'wp-start-upsert-pr',
            'wp-review-upsert-pr', 'wp-finish-upsert-pr', 'wp-land-pr', 'wp-cleanup']) {
            expect(store.isBlockedDuringResolve(command)).toBe(true);
            expect(message).toContain(`\`pnpm ${command}\``);
        }
        expect(message).toContain('That is the whole list');
    });

    it('offers both ways out and names the branch you are really on', (): void => {
        const message = refusal((): void => { store.assertIdle(repo, 'wp-cleanup'); });
        expect(message).toContain('dean/ONE-2275DevResolve');
        expect(message).toContain('pnpm wp-finish-push-dev');
        expect(message).toContain('--abort');
    });

    it('blocks nothing once the resolve is finished', (): void => {
        store.clear(repo);
        expect(refusal((): void => { store.assertIdle(repo, 'wp-cleanup'); })).toBe('');
    });

    it('does not block the dev-deploy commands themselves — they are how you get unstuck', (): void => {
        expect(store.isBlockedDuringResolve('wp-push-dev')).toBe(false);
        expect(store.isBlockedDuringResolve('wp-finish-push-dev')).toBe(false);
    });

    it('require() points at the one-command publish form when nothing is in flight', (): void => {
        store.clear(repo);
        const message = refusal((): void => { store.require(repo); });
        expect(message).toContain('No dev-deploy resolve is in progress');
        expect(message).toContain('pnpm wp-push-dev');
    });
});
