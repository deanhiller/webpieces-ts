import { RuleFailError, Option } from '@webpieces/rules-config';
import type { EnhancedGraph } from './graph-sorter';
import type { RuntimeGraph } from './runtime-graph-model';

/** Saved graphs have no reliable generation timestamp; file mtimes also change on checkout. */
export class SavedSnapshot {
    static refresh(): string {
        return 'Refresh explicitly: pnpm nx run architecture:generate';
    }

    static message(): string {
        return (
            'Saved generated snapshot. Viewing does not refresh architecture facts. ' +
            'Freshness unknown: no reliable generation provenance is recorded; current source has not been checked. ' +
            this.refresh()
        );
    }

    static html(): string {
        return (
            `<p class="hint"><strong>Saved generated snapshot.</strong> Viewing does not refresh architecture facts. ` +
            `Freshness unknown; current source has not been checked. ` +
            `Refresh explicitly: <code>pnpm nx run architecture:generate</code>.</p>`
        );
    }

    // webpieces-disable no-any-unknown -- saved JSON is untrusted until its shape has been checked
    private static isMap(value: unknown): boolean {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    static validateProjects(graph: EnhancedGraph, graphPath: string): void {
        if (
            !this.isMap(graph) ||
            Object.values(graph).some(
                (entry) =>
                    !this.isMap(entry) ||
                    !Number.isFinite(entry.level) ||
                    !Array.isArray(entry.dependsOn) ||
                    entry.dependsOn.some((dep) => typeof dep !== 'string'),
            )
        ) {
            throw new RuleFailError(
                'saved-architecture-snapshot',
                `Unusable saved project graph at ${graphPath}: expected projects with numeric level and string dependsOn arrays`,
                undefined,
                undefined,
                [new Option(this.refresh(), true)],
            );
        }
    }

    static validateRuntime(graph: RuntimeGraph | null): asserts graph is RuntimeGraph {
        if (
            graph === null ||
            !this.isMap(graph) ||
            !this.isMap(graph.services) ||
            !this.isMap(graph.apis) ||
            !this.isMap(graph.queues) ||
            !Array.isArray(graph.runtimeEdges) ||
            !Array.isArray(graph.unresolvedUses) ||
            !Array.isArray(graph.triggers)
        ) {
            throw new RuleFailError(
                'saved-architecture-snapshot',
                'Unusable saved runtime graph: expected services, apis, queues and runtimeEdges, unresolvedUses, triggers arrays',
                undefined,
                undefined,
                [new Option(this.refresh(), true)],
            );
        }
    }
}
