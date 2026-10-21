import { injectable, bindingScopeValues } from 'inversify';

/**
 * The ceiling on every external command the detached main-sync refresher runs (#1342).
 *
 * WHY EVERY ONE NEEDS A CEILING. The refresher is single-flight behind `main-sync.lock.json`, and the
 * lock is reclaimed once its holder is older than `hangTimeoutMinutes` (default 5). Reclaiming used to
 * be the whole of hang recovery, and it was not enough: no `spawnSync` here carried a `timeout`, so a
 * `git fetch` stuck on an ssh handshake, or a `gh pr list` stuck on the network, lived forever — and
 * after every reclaim the next refresher could stack another one beside it. A bounded command makes a
 * hung run END on its own; the reclaimer's kill (MainSyncLockService.tryAcquireMainSyncLock) is the
 * backstop for a process that is stuck somewhere no timeout reaches.
 *
 * Sized so ONE network command plus a handful of local ones stays well inside the default
 * 5-minute hang window. Node sends SIGTERM on expiry (the spawnSync default), which lets git clean up
 * its own `.lock` files rather than leaving them behind as SIGKILL would.
 */
@injectable(bindingScopeValues.Singleton)
export class CommandTimeouts {
    /** `git fetch` and `gh` — the two calls that cross the network. */
    static readonly NETWORK_MS = 90 * 1000;
    /** Local git (merge-base, rev-list, worktree list, status, …). Generous: a cold, large repo is slow, never hung. */
    static readonly LOCAL_GIT_MS = 30 * 1000;

    /** The ceiling for one captured command: `gh` talks to GitHub, everything else here is local git. */
    forCommand(cmd: string): number {
        return cmd === 'gh' ? CommandTimeouts.NETWORK_MS : CommandTimeouts.LOCAL_GIT_MS;
    }
}
