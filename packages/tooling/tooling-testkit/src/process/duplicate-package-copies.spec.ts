import 'reflect-metadata';
import { Container, inject, injectable } from 'inversify';
import { describe, expect, it, vi } from 'vitest';
import { GitProcessApi, GitResultDto, InformAiError, ProcessBindings, TimerApi } from '@webpieces/tooling-common';

import { MockGitProcessApi } from './mock-git-process-api';

/**
 * #1437: a package manager may install SEVERAL copies of `@webpieces/tooling-common` — this repo's own
 * hoisted install nests one under every dependent — so `BranchReaper` (repo-workflow-core) injects a
 * different `GitProcessApi` class object than the one `PrGateContainer` (pr-gate) bound. The `autobind`
 * container then constructed the ABSTRACT class, and `wp-start-upsert-pr` died with
 * `this.git.run is not a function`.
 *
 * Each test loads a genuinely SECOND copy of the module (`vi.resetModules()` + a fresh import evaluates
 * every source file again, so its classes are new objects) and builds the container exactly as every
 * `wp-*` bin does: `new Container({ autobind: true })` + `new ProcessBindings().bind(container)`.
 */

type ToolingCommon = typeof import('@webpieces/tooling-common');

interface HeadReader {
    headOf(repo: string): Promise<GitResultDto>;
}

class ConsumerFactory {
    /** A program class compiled against `copy` — the shape of BranchReaper against its nested copy. */
    defineConsumer(copy: ToolingCommon): new (git: GitProcessApi) => HeadReader {
        @injectable()
        class BranchReaperShape implements HeadReader {
            constructor(@inject(copy.GitProcessApi) private readonly git: GitProcessApi) {}

            headOf(repo: string): Promise<GitResultDto> {
                return this.git.run(['-C', repo, 'rev-parse', 'HEAD']);
            }
        }
        return BranchReaperShape;
    }
}

class CopyLoader {
    async loadSecondCopy(): Promise<ToolingCommon> {
        vi.resetModules();
        const copy: ToolingCommon = await import('@webpieces/tooling-common');
        // Guard the premise: without a distinct class object these tests prove nothing.
        expect(copy.GitProcessApi).not.toBe(GitProcessApi);
        return copy;
    }
}

describe('process edges across duplicate copies of @webpieces/tooling-common (#1437)', () => {
    it('a consumer importing the edge from a second copy resolves the edge the container bound', async () => {
        const second = await new CopyLoader().loadSecondCopy();
        const container = new Container({ autobind: true });
        new ProcessBindings().bind(container);
        // A feature test rebinds the edge of ITS copy; the alias carries that to every other copy.
        const git = new MockGitProcessApi();
        (await container.rebind(GitProcessApi)).toConstantValue(git);
        git.respond(['-C', '/repo', 'rev-parse', 'HEAD'], git.ok('abc123\n'));

        const program = container.get(new ConsumerFactory().defineConsumer(second));
        const head = await program.headOf('/repo');

        expect(head.stdout).toBe('abc123\n');
        expect(git.commandLines()).toEqual(['git -C /repo rev-parse HEAD']);
        // Every edge is aliased, not just git: the second copy's clock is the bound one.
        expect(container.get(second.TimerApi)).toBe(container.get(TimerApi));
    });

    it('a copy loaded only AFTER the edges were bound fails at resolution naming the edge, never "run is not a function"', async () => {
        const container = new Container({ autobind: true });
        new ProcessBindings().bind(container);
        const late = await new CopyLoader().loadSecondCopy();
        const consumer = new ConsumerFactory().defineConsumer(late);

        expect(() => container.get(consumer)).toThrow(InformAiError);
        expect(() => container.get(consumer)).toThrow('GitProcessApi was resolved with no binding');
        expect(() => container.get(consumer)).toThrow('new ProcessBindings().bind(container)');
    });
});
