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
