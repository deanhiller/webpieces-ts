import { minimatch } from 'minimatch';

/**
 * Holistic exclusion check shared by validate-ts-in-src (Layer 1 + Layer 2)
 * and the file-location AI-hook rule, so the two implementations can never
 * drift apart again.
 *
 * `relPath` is a workspace-relative path (e.g.
 * "libraries/foo/codegen.ts"). An entry in `excludePaths` matches when ANY
 * of the following hold:
 *
 *   1. Bare directory/segment name appearing anywhere in the path. This is
 *      the historical behavior and keeps entries like "node_modules",
 *      "dist", "scripts", "architecture" working at any depth.
 *   2. A glob matched against the full relative path, e.g. "**\/*.d.ts" or
 *      "**\/codegen.ts".
 *   3. A directory-prefix glob, e.g. "libraries/apis" -> "libraries/apis/**".
 *
 * Paths are normalized to forward slashes so Windows backslashes match too.
 */
export function isPathExcluded(relPath: string, excludePaths: readonly string[]): boolean {
    const norm = relPath.replace(/\\/g, '/');
    const segments = norm.split('/');
    for (const pattern of excludePaths) {
        if (segments.includes(pattern)) return true;
        if (minimatch(norm, pattern)) return true;
        if (minimatch(norm, `${pattern}/**`)) return true;
    }
    return false;
}

/**
 * Does `relPath` match any of `patterns`, as a glob or as a directory prefix?
 *
 * The strict sibling of {@link isPathExcluded}: it drops rule 1 (bare segment name matching anywhere
 * in the path), which is right for an opt-out exclusion list but wrong for anything that CLASSIFIES
 * a path — a pattern like "external" would otherwise claim every path containing that segment at any
 * depth. Used for config lists that positively identify a set of projects (e.g.
 * `runtime-architecture.externalApiPaths`).
 *
 * Paths are normalized to forward slashes so Windows backslashes match too. Empty `patterns` matches
 * nothing, so an unconfigured list is inert rather than universal.
 */
// webpieces-disable no-function-outside-class -- pure path predicate, sibling of isPathExcluded above
export function matchesAnyGlob(relPath: string, patterns: readonly string[]): boolean {
    const norm = relPath.replace(/\\/g, '/');
    for (const pattern of patterns) {
        if (minimatch(norm, pattern)) return true;
        if (minimatch(norm, `${pattern}/**`)) return true;
    }
    return false;
}
