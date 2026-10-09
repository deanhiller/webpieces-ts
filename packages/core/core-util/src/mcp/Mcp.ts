/** Profile identifiers are application groups, independent of paths and account roles. */
export class Mcp {
    static readonly DEFAULT = 'default';

    /** Validate and snapshot authored membership; never broaden an invalid selection. */
    // webpieces-disable no-function-outside-class -- pure browser-safe membership validator shared across runtime and compiler
    static profiles(
        profiles: readonly string[],
        source: string,
        failure: (message: string) => Error = (message: string): Error => new Error(message),
    ): readonly string[] {
        if (!Array.isArray(profiles) || profiles.length === 0) {
            throw failure(`${source} requires a non-empty profiles array, e.g. [Mcp.DEFAULT].`);
        }
        const seen = new Set<string>();
        for (const profile of profiles) {
            if (typeof profile !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(profile)) {
                throw failure(`${source}: profile identifiers must match [a-z][a-z0-9-]{0,63}.`);
            }
            if (seen.has(profile)) throw failure(`${source}: duplicate profile '${profile}'.`);
            seen.add(profile);
        }
        return Object.freeze([...profiles].sort());
    }
}

/** Optional membership for @WpMcpTool; omission means only Mcp.DEFAULT. */
export class McpToolProfilesOptions {
    readonly profiles?: readonly string[];
}
