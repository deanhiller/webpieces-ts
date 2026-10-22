import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Container } from 'inversify';
import { GitProcessApi, NativeProcessApi } from '@webpieces/tooling-common';
import { MockGitProcessApi, MockNativeProcessApi } from '@webpieces/tooling-testkit';

import { PrGateContainer } from '../scripts/pr-gate-container';

/**
 * A feature test's program: the SHIPPED container (`new PrGateContainer().create()`, the one every `wp-*` bin
 * resolves from) with only the process edges rebound to mocks. Everything a test resolves from
 * `container` is the production DAG; `git` and `processes` are what the outside world answers.
 */
export class PrGateFeature {
    constructor(
        readonly container: Container,
        readonly git: MockGitProcessApi,
        readonly processes: MockNativeProcessApi,
    ) {}

    static async create(): Promise<PrGateFeature> {
        const container = new PrGateContainer().create();
        const git = new MockGitProcessApi();
        const processes = new MockNativeProcessApi();
        (await container.rebind(GitProcessApi)).toConstantValue(git);
        (await container.rebind(NativeProcessApi)).toConstantValue(processes);
        return new PrGateFeature(container, git, processes);
    }
}

/**
 * A primary clone with ONE linked worktree, laid out on disk exactly as git lays it out — without running
 * git (#1381). Every webpieces reader of "where is this checkout" (GitCheckout, DotWebpieces) reads these
 * files and starts no process, so a spec about log or state PLACEMENT needs only the layout:
 *
 *   primary/.git/{HEAD, objects/}                                   the primary clone, on `main`
 *   primary/.git/worktrees/<name>/{HEAD, commondir, gitdir}         git's record of the linked worktree
 *   <worktree>/.git                                                 `gitdir: <primary>/.git/worktrees/<name>`
 */
export class CheckoutLayout {
    /** A primary clone on `branch` — what `git init -b <branch>` leaves. */
    static primary(primary: string, branch: string): void {
        const gitDir = path.join(primary, '.git');
        fs.mkdirSync(path.join(gitDir, 'objects'), { recursive: true });
        fs.writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`);
    }

    static primaryWithWorktree(primary: string, worktree: string, branch: string): void {
        CheckoutLayout.primary(primary, 'main');
        CheckoutLayout.linkedWorktree(primary, worktree, branch);
    }

    /** One more linked worktree of an existing primary clone — what `git worktree add` records. */
    static linkedWorktree(primary: string, worktree: string, branch: string): void {
        const record = path.join(primary, '.git', 'worktrees', path.basename(worktree));
        fs.mkdirSync(record, { recursive: true });
        fs.writeFileSync(path.join(record, 'HEAD'), `ref: refs/heads/${branch}\n`);
        fs.writeFileSync(path.join(record, 'commondir'), '../..\n');
        fs.writeFileSync(path.join(record, 'gitdir'), `${path.join(worktree, '.git')}\n`);
        fs.mkdirSync(worktree, { recursive: true });
        fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${record}\n`);
    }
}

/** Everything a program wrote to stdout and stderr while a test ran it. */
export class CapturedOutput {
    stdout = '';
    stderr = '';
    private readonly restore: (() => void)[] = [];

    static start(): CapturedOutput {
        const captured = new CapturedOutput();
        const out = process.stdout.write.bind(process.stdout);
        const err = process.stderr.write.bind(process.stderr);
        process.stdout.write = ((chunk: string | Uint8Array): boolean => {
            captured.stdout += String(chunk);
            return true;
        }) as typeof process.stdout.write;
        process.stderr.write = ((chunk: string | Uint8Array): boolean => {
            captured.stderr += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        captured.restore.push((): void => {
            process.stdout.write = out;
            process.stderr.write = err;
        });
        return captured;
    }

    stop(): void {
        for (const undo of this.restore) undo();
        this.restore.length = 0;
    }
}
