/**
 * Graph Names
 *
 * The two names a project has in the visualization, kept apart on purpose:
 *
 *  - its NODE ID — the identity every DOT node, edge endpoint, `rank=same` member, lock-dropdown
 *    value and responsibilities `data-node` attribute is keyed on. It is the project KEY, verbatim.
 *  - its SHORT NAME — the human-facing label, with the `@scope/` prefix stripped.
 *
 * They used to be the same string, and that was a silent, badly-wrong-picture bug. A workspace may
 * legitimately hold `@scope/public-api` (an L0 contract lib) AND `public-api` (the L6 server that
 * serves it) — two DISTINCT projects that strip to the same short name. Keying the DOT on the short
 * name fused them into one node, and graphviz UNIONS any two `rank=same` sets sharing a node, so
 * L0's rank and L6's rank became one rank: the entire L0 band rendered on the L6 row, the invisible
 * anchor chain that pins level order became unsatisfiable (it demands L0 strictly below L6 while the
 * union says they are equal) and was discarded, and the server's dependency on the contract lib drew
 * as a self-loop on the fused box.
 *
 * So identity is the project key and nothing else — collision is structurally impossible now rather
 * than merely unlikely — and {@link GraphNames.assertUniqueNodeIds} asserts that, so a future change
 * that reintroduces a lossy id fails generation loudly instead of drawing a wrong graph in silence.
 *
 * Kept in its own class so GraphVisualizer and ResponsibilitiesRenderer can both depend on it
 * without a circular dependency between them.
 */

/** One project key and the level it sits on — what a collision report has to name. */
export class NodeIdOwner {
    constructor(
        public readonly projectKey: string,
        public readonly level: number,
    ) {}
}

/** Thrown when two distinct project keys would be drawn as the same DOT node. */
export class NodeIdCollisionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NodeIdCollisionError';
    }
}

export class GraphNames {
    /**
     * The DOT/DOM identity of a project: its project KEY, unchanged.
     *
     * This is deliberately a named method rather than an inlined `project` at ten call sites — the
     * node id is one decision, and it has to be made in one place or the DOT, the lock dropdown and
     * the responsibilities cards drift apart and the hover/lock wiring silently stops matching.
     */
    getNodeId(projectKey: string): string {
        return projectKey;
    }

    /**
     * The human-facing display name: scope stripped.
     * '@scope/name' → 'name'
     * 'name' → 'name'
     *
     * LABELS ONLY. Never use this as an identity — see this file's header for what that cost.
     */
    getShortName(name: string): string {
        return name.includes('/') ? name.split('/').pop()! : name;
    }

    /**
     * Assert that every project draws as its own node.
     *
     * Fails LOUDLY, naming both colliding project keys and their levels, because the failure mode it
     * guards is a graph that renders happily and says something false.
     */
    assertUniqueNodeIds(owners: NodeIdOwner[]): void {
        const byNodeId = new Map<string, NodeIdOwner[]>();
        for (const owner of owners) {
            const nodeId = this.getNodeId(owner.projectKey);
            const existing = byNodeId.get(nodeId);
            if (existing === undefined) byNodeId.set(nodeId, [owner]);
            else existing.push(owner);
        }
        const collisions: string[] = [];
        for (const nodeId of [...byNodeId.keys()].sort()) {
            const sharers = byNodeId.get(nodeId) as NodeIdOwner[];
            if (sharers.length < 2) continue;
            const named = sharers
                .map((owner: NodeIdOwner): string => `"${owner.projectKey}" (L${owner.level})`)
                .sort()
                .join(' and ');
            collisions.push(`  node "${nodeId}" would be drawn for ${named}`);
        }
        if (collisions.length === 0) return;
        throw new NodeIdCollisionError(
            'Two distinct projects map to the same graph node, so the rendered architecture graph '
            + 'would fuse them (and fuse their dependency levels into one row):\n'
            + collisions.sort().join('\n')
            + '\nFix: getNodeId() must stay a 1:1 function of the project key — it is the project '
            + 'key verbatim. Only getShortName() may drop the scope, and only for LABELS.');
    }
}
