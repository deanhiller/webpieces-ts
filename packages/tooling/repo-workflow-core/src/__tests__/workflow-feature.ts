import 'reflect-metadata';
import { Container } from 'inversify';
import { GitProcessApi, NativeProcessApi, ProcessBindings, TimerApi } from '@webpieces/tooling-common';
import { MockGitProcessApi, MockNativeProcessApi, MockTimerApi } from '@webpieces/tooling-testkit';

/**
 * A feature test's program for repo-workflow-core (#1381): the container every tooling entry point
 * builds — `autobind` plus the production edges from ProcessBindings — with ONLY those edges rebound to
 * mocks. Everything resolved from `container` is the production DAG (MergedBranchesService,
 * BranchReaper, WorktreeReaper, MainSyncStatusService, …); `git`, `processes` and `timer` are what the
 * outside world answers, and where the test reads what the program asked of it.
 */
export class WorkflowFeature {
    constructor(
        readonly container: Container,
        readonly git: MockGitProcessApi,
        readonly processes: MockNativeProcessApi,
        readonly timer: MockTimerApi,
    ) {}

    static async create(): Promise<WorkflowFeature> {
        const container = new Container({ autobind: true });
        new ProcessBindings().bind(container);
        const git = new MockGitProcessApi();
        const processes = new MockNativeProcessApi();
        const timer = new MockTimerApi();
        (await container.rebind(GitProcessApi)).toConstantValue(git);
        (await container.rebind(NativeProcessApi)).toConstantValue(processes);
        (await container.rebind(TimerApi)).toConstantValue(timer);
        return new WorkflowFeature(container, git, processes, timer);
    }
}

/** `git worktree list --porcelain` output for the given records, each `[path, head, branch | '']`. */
export class Porcelain {
    static of(records: readonly (readonly string[])[]): string {
        return records.map((record: readonly string[]): string => {
            const branch = record[2] ?? '';
            const lines = [`worktree ${record[0]}`, `HEAD ${record[1]}`];
            lines.push(branch === '' ? 'detached' : `branch refs/heads/${branch}`);
            lines.push(...record.slice(3));
            return lines.join('\n') + '\n';
        }).join('\n');
    }
}
