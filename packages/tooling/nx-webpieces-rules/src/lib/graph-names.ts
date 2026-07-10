/**
 * Graph Names
 *
 * Shared helper for turning a scoped project name into the short display name
 * used everywhere in the visualization (graph box titles, the lock-control
 * options, and the responsibilities cards). Kept in its own class so both
 * GraphVisualizer and ResponsibilitiesRenderer can depend on it without a
 * circular dependency between them.
 */

export class GraphNames {
    /**
     * Remove scope from name for display
     * '@scope/name' → 'name'
     * 'name' → 'name'
     */
    getShortName(name: string): string {
        return name.includes('/') ? name.split('/').pop()! : name;
    }
}
