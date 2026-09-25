import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import { BranchIdentity, PrSummary, ReviewJsonService, specTempDirs } from '@webpieces/rules-config';
import { HotfixFinishPreparer } from './hotfix-finish-preparer';
import { AiBranchName } from './git-readAiBranchName';
import { GitExec } from './git-exec';
import { BuildAffected } from './build-affected';
import { BuildArtifactGate } from './build-artifact-gate';
import { MergeState } from './merge-state';
import { MergeEnd } from './merge-end';
import { ChecklistScan, ChecklistScanner } from './checklist-scanner';
import { DiffMaterializer } from './diff-materializer';
import { PrContextWriter } from './pr-context-writer';
import { ProvenanceEnforcer, ProvenanceReport } from './provenance-enforcer';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
    const dir = specTempDirs.makeReal('wp-hotfix-finish-');
    dirs.push(dir);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'spec@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'spec'], { cwd: dir });
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'init'], { cwd: dir });
    execFileSync('git', ['checkout', '-qb', 'dean/hotfix/urgent'], { cwd: dir });
    return dir;
}

function asType<T>(value: object): T {
    return value as unknown as T;
}

describe('HotfixFinishPreparer', () => {
    it('builds and prepares publication without any stage-two receipt or reviewer verdict', async () => {
        const root = repo();
        let builds = 0;
        const scan = asType<ChecklistScan>({
            basis: { unresolved: true },
            changedFiles: [],
            suppressed: [],
            applicable: [],
        });
        const preparer = new HotfixFinishPreparer(
            asType<BranchIdentity>({ current: (): string => 'dean/hotfix/urgent' }),
            asType<AiBranchName>({ getFeatureName: (): string => 'dean-hotfix-urgent' }),
            asType<GitExec>({ assertCleanTree: (): void => undefined }),
            asType<ReviewJsonService>({
                loadSummaryJson: (): PrSummary => new PrSummary('codex', 'gpt-5', 'Urgent fix', 60, 'yellow', '🟡', 'Summary.', [], [], []),
            }),
            asType<BuildAffected>({
                runBuildGate: async (): Promise<void> => {
                    builds += 1;
                },
            }),
            asType<BuildArtifactGate>({ assertBuildLeftNothingUncommitted: (): void => undefined }),
            asType<MergeState>({
                mergeDirFor: (): string => '/none',
                findActiveMergeRunDir: (): null => null,
            }),
            asType<MergeEnd>({}),
            asType<ChecklistScanner>({ scan: (): ChecklistScan => scan }),
            asType<DiffMaterializer>({}),
            asType<PrContextWriter>({}),
            asType<ProvenanceEnforcer>({
                enforce: (): ProvenanceReport => new ProvenanceReport(true, []),
            }),
        );

        const state = await preparer.prepare(root);
        expect(builds).toBe(1);
        expect(state.review.title).toBe('Urgent fix');
        expect(state.provenance.evidence).toEqual([]);
    });

    it('finalizes a pending conflict resolution before building', async () => {
        const root = repo();
        const order: string[] = [];
        const marker = {
            validated: false,
            currentBranch: 'dean/hotfix/urgent',
            squashBranch: 'temp',
            backupBranch: 'backup',
            prNumber: '',
            conflictedFiles: ['src/a.ts'],
        };
        const scan = asType<ChecklistScan>({ basis: { unresolved: true }, changedFiles: [] });
        const preparer = new HotfixFinishPreparer(
            asType<BranchIdentity>({ current: (): string => 'dean/hotfix/urgent' }),
            asType<AiBranchName>({ getFeatureName: (): string => 'dean-hotfix-urgent' }),
            asType<GitExec>({ assertCleanTree: (): void => undefined }),
            asType<ReviewJsonService>({
                loadSummaryJson: (): PrSummary => new PrSummary('codex', 'gpt-5', 'Urgent fix', 60, 'yellow', '🟡', 'Summary.', [], [], []),
            }),
            asType<BuildAffected>({
                runBuildGate: async (): Promise<void> => {
                    order.push('build');
                },
            }),
            asType<BuildArtifactGate>({ assertBuildLeftNothingUncommitted: (): void => undefined }),
            asType<MergeState>({
                mergeDirFor: (): string => '/merge',
                findActiveMergeRunDir: (): string => '/merge/run',
                readMergeMarker: (): object => marker,
            }),
            asType<MergeEnd>({
                mergeEnd: async (): Promise<void> => {
                    order.push('merge');
                },
            }),
            asType<ChecklistScanner>({ scan: (): ChecklistScan => scan }),
            asType<DiffMaterializer>({}),
            asType<PrContextWriter>({}),
            asType<ProvenanceEnforcer>({
                enforce: (): ProvenanceReport => new ProvenanceReport(true, []),
            }),
        );

        await preparer.prepare(root);
        expect(order).toEqual(['merge', 'build']);
    });
});
