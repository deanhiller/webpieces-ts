import 'reflect-metadata';
import { Container } from 'inversify';
import { GitProcessApi, NativeProcessApi, ProcessBindings, TimerApi } from '@webpieces/tooling-common';
import { MockGitProcessApi, MockNativeProcessApi, MockTimerApi } from '@webpieces/tooling-testkit';

/**
 * A feature test's program for rules-config (#1381): the container every tooling entry point builds —
 * `autobind` plus the production edges from ProcessBindings — with ONLY those edges rebound to mocks.
 * Everything resolved from `container` is the production DAG (DiffScope, PolicyTracking,
 * OrphanDirSweeper, and the repo-workflow-core services rules-config hosts specs for); `git`,
 * `processes` and `timer` are what the outside world answers, and where the test reads what was asked.
 */
export class RulesConfigFeature {
    constructor(
        readonly container: Container,
        readonly git: MockGitProcessApi,
        readonly processes: MockNativeProcessApi,
        readonly timer: MockTimerApi,
    ) {}

    static async create(): Promise<RulesConfigFeature> {
        const container = new Container({ autobind: true });
        new ProcessBindings().bind(container);
        const git = new MockGitProcessApi();
        const processes = new MockNativeProcessApi();
        const timer = new MockTimerApi();
        (await container.rebind(GitProcessApi)).toConstantValue(git);
        (await container.rebind(NativeProcessApi)).toConstantValue(processes);
        (await container.rebind(TimerApi)).toConstantValue(timer);
        return new RulesConfigFeature(container, git, processes, timer);
    }
}
