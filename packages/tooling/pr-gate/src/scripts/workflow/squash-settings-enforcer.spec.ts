import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CapturedOutput, PrGateFeature } from '../../__tests__/feature-harness';
import { SquashSettingsEnforcer, SQUASH_MESSAGE_REQUIRED, SQUASH_TITLE_REQUIRED } from './squash-settings-enforcer';

// The production enforcer from the shipped container, with `gh` SCRIPTED (#1381): nothing here touches
// gh or the network. The READ is one `gh api repos/{owner}/{repo} --jq …`; the REPAIR is `gh api -X PATCH`.
const READ = ['api', 'repos/{owner}/{repo}', '--jq'];
const PATCH = ['api', '-X', 'PATCH'];

let feature: PrGateFeature;
let output: CapturedOutput;

/** What GitHub answers for the repo: title, message, and whether this token is an admin. */
function repoSays(title: string, message: string, admin: boolean): void {
    feature.processes.respondToPrefix('gh', READ, feature.processes.ok(`${title}\t${message}\t${String(admin)}\n`));
}

function patches(): number {
    return feature.processes.callsStartingWith('gh', PATCH).length;
}

function said(): string {
    return output.stdout + output.stderr;
}

async function ensure(): Promise<void> {
    await feature.container.get(SquashSettingsEnforcer).ensure();
}

beforeEach(async (): Promise<void> => {
    feature = await PrGateFeature.create();
    output = CapturedOutput.start();
});

afterEach((): void => {
    output.stop();
});

describe('SquashSettingsEnforcer — the correct pair costs nothing', () => {
    it('does nothing at all when the settings are already PR_TITLE + PR_BODY', async () => {
        repoSays(SQUASH_TITLE_REQUIRED, SQUASH_MESSAGE_REQUIRED, true);

        await ensure();

        expect(patches()).toBe(0);
        expect(said()).toBe('');
        // ONE api read is the whole cost of the common case.
        expect(feature.processes.calls).toHaveLength(1);
    });
});

describe('SquashSettingsEnforcer — repair', () => {
    /**
     * COMMIT_MESSAGES is the live case this was written for: the framework's own repo sat on it while both
     * consumer repos were already correct, so a UI merge there would have landed the branch's raw internal
     * commit messages instead of the gated body.
     */
    it('repairs COMMIT_MESSAGES and says what it changed', async () => {
        repoSays(SQUASH_TITLE_REQUIRED, 'COMMIT_MESSAGES', true);
        feature.processes.respondToPrefix('gh', PATCH, feature.processes.ok());

        await ensure();

        expect(patches()).toBe(1);
        const patch = feature.processes.callsStartingWith('gh', PATCH)[0].commandLine;
        expect(patch).toContain(`squash_merge_commit_title=${SQUASH_TITLE_REQUIRED}`);
        expect(patch).toContain(`squash_merge_commit_message=${SQUASH_MESSAGE_REQUIRED}`);
        // Never silent: a tool that changes a shared repo's settings has to say so, and say what it was.
        expect(said()).toContain('COMMIT_MESSAGES');
        expect(said()).toContain('PR_TITLE');
        expect(said()).toContain('PR_BODY');
    });

    it('repairs a wrong TITLE too, not just the message', async () => {
        repoSays('MERGE_MESSAGE', SQUASH_MESSAGE_REQUIRED, true);
        feature.processes.respondToPrefix('gh', PATCH, feature.processes.ok());

        await ensure();

        expect(patches()).toBe(1);
    });

    it('reports the consequence when the PATCH itself fails, and never throws', async () => {
        repoSays(SQUASH_TITLE_REQUIRED, 'BLANK', true);
        feature.processes.respondToPrefix('gh', PATCH, feature.processes.fail(1, 'HTTP 403'));

        await expect(ensure()).resolves.toBeUndefined();
        expect(said()).toContain('gh api -X PATCH');
    });
});

describe('SquashSettingsEnforcer — no admin, and unreadable', () => {
    /**
     * A contributor without admin must not be blocked by a setting only an owner can change, so this
     * degrades to a warning — but one that names the consequence and hands over a runnable command, since
     * the reader's job is to forward it, not to go research what these settings do.
     */
    it('warns with a runnable command instead of attempting a PATCH it cannot make', async () => {
        repoSays(SQUASH_TITLE_REQUIRED, 'COMMIT_MESSAGES', false);

        await ensure();

        expect(patches()).toBe(0);
        expect(said()).toContain('not an admin');
        expect(said()).toContain('gh api -X PATCH');
        // wp-land-pr passes --body-file explicitly, so it is right regardless — worth saying, because it
        // means the reader is not actually stuck while they wait on an owner.
        expect(said()).toContain('wp-land-pr');
    });

    /**
     * An unreadable answer is NOT a diagnosis. A gh hiccup must never be read as "wrong" — that would
     * PATCH a repo whose settings were fine, on no evidence.
     */
    it('treats an unreadable answer as unknown, never as wrong', async () => {
        feature.processes.respondToPrefix('gh', READ, feature.processes.fail(1, 'error connecting to api.github.com'));

        await ensure();

        expect(patches()).toBe(0);
        expect(said()).toContain('Could not read');
    });
});
