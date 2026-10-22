import { injectable, bindingScopeValues } from 'inversify';
import {
    GitProcessApi,
    GitProcessClient,
    GitResultDto,
    NativeProcessApi,
    NativeProcessClient,
    ProcessResultDto,
    ScheduledTaskDto,
    TaskDto,
    TimerApi,
    TimerClient,
} from '@webpieces/tooling-common';

/**
 * The ceiling on every external command the detached main-sync refresher runs (#1342), and the ONE place
 * those commands are bounded.
 *
 * WHY EVERY ONE NEEDS A CEILING. The refresher is single-flight behind `main-sync.lock.json`, and the
 * lock is reclaimed once its holder is older than `hangTimeoutMinutes` (default 5). Reclaiming used to
 * be the whole of hang recovery, and it was not enough: no command here carried a deadline, so a
 * `git fetch` stuck on an ssh handshake, or a `gh pr list` stuck on the network, lived forever — and
 * after every reclaim the next refresher could stack another one beside it. A bounded command makes a
 * hung run END on its own; the reclaimer's kill (MainSyncLockService.tryAcquireMainSyncLock) is the
 * backstop for a process that is stuck somewhere no deadline reaches.
 *
 * Sized so ONE network command plus a handful of local ones stays well inside the default
 * 5-minute hang window. The kill is SIGTERM (node's default), which lets git clean up its own `.lock`
 * files rather than leaving them behind as SIGKILL would.
 *
 * HOW (#1381): the command goes through the process edges, and its deadline is a task scheduled on the
 * clock edge (`TimerApi`) that aborts the run. A feature test therefore SEES each requested deadline
 * (`MockTimerApi.getScheduledTasks()`), and fires it itself to prove the timeout path — no real time
 * passes. The one synchronous form ({@link localGitNow}) exists for the PreToolUse guard's blocking path,
 * whose `check()` contract is synchronous; its kill-after is passed straight to the edge.
 */
@injectable(bindingScopeValues.Singleton)
export class CommandTimeouts {
    /** `git fetch` and `gh` — the two calls that cross the network. */
    static readonly NETWORK_MS = 90 * 1000;
    /** Local git (merge-base, rev-list, worktree list, status, …). Generous: a cold, large repo is slow, never hung. */
    static readonly LOCAL_GIT_MS = 30 * 1000;

    // Defaulted so the non-DI call sites (the guard, the detached refresher) can `new` this, while
    // inversify injects the container's edges — which is what a feature test rebinds.
    constructor(
        private readonly git: GitProcessApi = new GitProcessClient(),
        private readonly processes: NativeProcessApi = new NativeProcessClient(),
        private readonly timer: TimerApi = new TimerClient(),
    ) {}

    /** Local git, killed after {@link LOCAL_GIT_MS}. */
    localGit(args: string[], cwd: string): Promise<GitResultDto> {
        return this.boundedGit(args, cwd, CommandTimeouts.LOCAL_GIT_MS);
    }

    /** Network git (`fetch`), killed after {@link NETWORK_MS}. */
    networkGit(args: string[], cwd: string): Promise<GitResultDto> {
        return this.boundedGit(args, cwd, CommandTimeouts.NETWORK_MS);
    }

    /** `gh`, killed after {@link NETWORK_MS}. */
    async gh(args: string[], cwd: string): Promise<ProcessResultDto> {
        const abort = new AbortController();
        const deadline = this.deadline(CommandTimeouts.NETWORK_MS, `gh ${args.join(' ')}`, abort);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return await this.processes.run('gh', args, cwd, abort.signal);
        } finally {
            deadline.cancel();
        }
    }

    /** Local git, SYNCHRONOUSLY — the guard's blocking path only. Killed after {@link LOCAL_GIT_MS}. */
    localGitNow(args: string[], cwd: string): GitResultDto {
        return this.git.runSync(args, cwd, CommandTimeouts.LOCAL_GIT_MS);
    }

    private async boundedGit(args: string[], cwd: string, timeoutMs: number): Promise<GitResultDto> {
        const abort = new AbortController();
        const deadline = this.deadline(timeoutMs, `git ${args.join(' ')}`, abort);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return await this.git.run(args, cwd, abort.signal);
        } finally {
            deadline.cancel();
        }
    }

    private deadline(timeoutMs: number, command: string, abort: AbortController): ScheduledTaskDto {
        return this.timer.schedule(timeoutMs, new TaskDto(`deadline for \`${command}\``, (): void => abort.abort()));
    }
}
