import { matchesAnyGlob } from './exclude-paths';

export class PathMatchCandidate<T> {
    constructor(
        readonly paths: readonly string[],
        readonly value: T,
    ) {}
}

export class FirstPathMatchResult<T> {
    constructor(
        readonly entry: T,
        readonly glob: string,
    ) {}
}

/** Ordered glob selection is generic; callers own their payload and overlap policy. */
export class FirstPathMatch {
    winner<T>(
        relativePath: string,
        candidates: readonly PathMatchCandidate<T>[],
    ): FirstPathMatchResult<T> | undefined {
        for (const candidate of candidates) {
            const glob = candidate.paths.find((pattern: string) =>
                matchesAnyGlob(relativePath, [pattern]),
            );
            if (glob !== undefined) return new FirstPathMatchResult(candidate.value, glob);
        }
        return undefined;
    }
}
