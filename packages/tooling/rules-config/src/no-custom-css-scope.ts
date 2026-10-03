import { matchesAnyGlob } from './exclude-paths';

/**
 * Test sources are never Angular UI, so no engine has ever enforced `no-custom-css` on them. The list
 * lived TWICE — once in the hook rule, once in the CI validator — which is the same duplication that
 * let `allowGlobs` diverge. One copy, here, beside the exemption it belongs to.
 */
const TEST_PATHS: readonly RegExp[] = [/\.test\.ts$/, /\.spec\.ts$/, /__tests__\//];

/**
 * Shared path exemption used by both edit-time and build-time CSS enforcement.
 * The owning pack validates its schema; this helper consumes the resolved path
 * settings without importing either implementation pack or its concrete config class.
 * Both consumers use the same matcher so configured exemptions cannot drift.
 */
/** A structural path-exemption input, independent of any concrete owner schema. */
export class PathScopeConfig {
    allowGlobs?: string[];
}

export class NoCustomCssScope {
    private readonly allowGlobs: readonly string[];

    constructor(config: PathScopeConfig) {
        this.allowGlobs = config.allowGlobs ?? [];
    }

    /** True when `no-custom-css` must not look at this path at all — a test source, or a configured `allowGlobs` match. */
    isExempt(relPath: string): boolean {
        const norm = relPath.replace(/\\/g, '/');
        if (TEST_PATHS.some((re: RegExp) => re.test(norm))) return true;
        return matchesAnyGlob(norm, this.allowGlobs);
    }
}
