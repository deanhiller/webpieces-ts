import { spawnSync } from 'child_process';
import { injectable, bindingScopeValues } from 'inversify';
import { ConsumerBin } from './consumer-bin-resolver';

/** One finished generator process. Data-only. */
export class GeneratorRun {
    constructor(
        readonly exitCode: number,
        /** stdout and stderr, in that order — the generator reports its refusals on stdout. */
        readonly output: string,
    ) {}

    get ok(): boolean {
        return this.exitCode === 0;
    }
}

/**
 * Runs a resolved {@link ConsumerBin} with the node that is running US, so the generator gets the
 * consumer's `node_modules` (it lives there) without depending on a `.bin` shim or on `PATH`.
 *
 * It REPORTS the outcome rather than throwing on a non-zero exit, because the two callers mean
 * different things by one: the nx executor refuses the build, while the PR gate's merge-base run
 * records "the merge-base does not generate with today's generator" and says so in the PR.
 */
@injectable(bindingScopeValues.Singleton)
export class GeneratorRunner {
    run(bin: ConsumerBin, args: readonly string[], cwd: string): GeneratorRun {
        const result = spawnSync(process.execPath, [bin.binPath, ...args], { cwd, encoding: 'utf8' });
        const output = [result.stdout ?? '', result.stderr ?? '', result.error?.message ?? '']
            .filter((part: string) => part.trim() !== '')
            .join('\n')
            .trim();
        return new GeneratorRun(result.status ?? 1, output);
    }
}
