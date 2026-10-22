import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CliExitError } from '@webpieces/rules-config';

// The current branch comes from the ONE shared resolver (#1355) — a filesystem read, not a process; it
// answers what this suite dictates.
const state = vi.hoisted(() => ({ branch: 'dean/x' }));

vi.mock('@webpieces/tooling-common', async (importOriginal: () => Promise<typeof import('@webpieces/tooling-common')>) => {
    const actual = await importOriginal();
    class DictatedCheckout extends actual.GitCheckout {
        override branch(): string {
            return state.branch;
        }
    }
    return { ...actual, gitCheckout: new DictatedCheckout() };
});

import { PrGateFeature } from '../__tests__/feature-harness';
import { StartUpdateCommand } from './commands/start-update-command';

// `gh pr list --head <base> --state open …` — the open-PR lookup, SCRIPTED (#1381).
const PR_LIST = ['pr', 'list', '--head'];

let feature: PrGateFeature;

function assertNoOpenPr(): Promise<void> {
    return feature.container.get(StartUpdateCommand).assertNoOpenPr('/repo');
}

describe('wp-start-update assertNoOpenPr (Bug #4: fail-fast when an open PR exists)', () => {
    beforeEach(async () => {
        state.branch = 'dean/x';
        feature = await PrGateFeature.create();
    });

    it('does nothing when there is no open PR', async () => {
        feature.processes.respondToPrefix('gh', PR_LIST, feature.processes.ok('\n'));
        await expect(assertNoOpenPr()).resolves.toBeUndefined();
    });

    it('FAILS FAST when gh cannot reach GitHub (never assumes "no PR")', async () => {
        // gh exits non-zero (offline / not authenticated). We must NOT treat that as "no open PR" and
        // proceed — that is exactly how a PR gets stranded on the old branch generation.
        feature.processes.respondToPrefix('gh', PR_LIST, feature.processes.fail(1, 'gh: not authenticated'));
        const call = assertNoOpenPr();
        await expect(call).rejects.toBeInstanceOf(CliExitError);
        await expect(call).rejects.toThrow(/Could not ask GitHub/);
        await expect(call).rejects.toThrow(/gh: not authenticated/);
    });

    it('throws a CliExitError steering to the PR flow when an open PR exists', async () => {
        feature.processes.respondToPrefix('gh', PR_LIST, feature.processes.ok('42\n'));
        const call = assertNoOpenPr();
        await expect(call).rejects.toBeInstanceOf(CliExitError);
        // The message names the offending PR and both PR-flow commands.
        await expect(call).rejects.toThrow(/#42/);
        await expect(call).rejects.toThrow(/wp-start-upsert-pr/);
        await expect(call).rejects.toThrow(/wp-finish-upsert-pr/);
    });

    it('resolves the open PR by the STABLE base name for a numbered generation branch', async () => {
        // On dean/xwp3 the PR still lives on the base `dean/x`; the guard must still fire.
        state.branch = 'dean/xwp3';
        feature.processes.respondToPrefix('gh', PR_LIST, feature.processes.ok('7\n'));
        await expect(assertNoOpenPr()).rejects.toBeInstanceOf(CliExitError);
        expect(feature.processes.callsStartingWith('gh', PR_LIST)[0].args)
            .toEqual(['pr', 'list', '--head', 'dean/x', '--state', 'open', '--json', 'number', '--jq', '.[0].number']);
    });
});
