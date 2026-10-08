import { RuleFailError, Option } from '@webpieces/rules-config';
import type { EnhancedGraph } from './graph-sorter';
import type { RuntimeGraph } from './runtime-graph-model';
import { DependenciesFile, loadBlessedGraph } from './graph-loader';
import {
    DEFAULT_RUNTIME_GRAPH_PATH,
    loadRuntimeGraph,
    runtimeGraphFileExists,
} from './runtime-graph-io';
import { toError } from '../toError';

/** Saved graphs have no reliable generation timestamp; file mtimes also change on checkout. */
export class SavedSnapshot {
    refresh(): string {
        return 'Refresh explicitly: pnpm nx run architecture:generate';
    }

    message(): string {
        return (
            'Saved generated snapshot. Viewing does not refresh architecture facts. ' +
            'Freshness unknown: no reliable generation provenance is recorded; current source has not been checked. ' +
            this.refresh()
        );
    }

    html(): string {
        return (
            `<p class="hint"><strong>Saved generated snapshot.</strong> Viewing does not refresh architecture facts. ` +
            `Freshness unknown; current source has not been checked. ` +
            `Refresh explicitly: <code>pnpm nx run architecture:generate</code>.</p>`
        );
    }

    loadProjects(workspaceRoot: string, graphPath: string): DependenciesFile {
        const file = this.readArtifact(graphPath, () => loadBlessedGraph(workspaceRoot, graphPath));
        if (file === null) throw this.failure(`No saved graph found at ${graphPath}`);
        this.validateProjects(file.projects, graphPath);
        return file;
    }

    loadRuntime(workspaceRoot: string): RuntimeGraph {
        if (!runtimeGraphFileExists(workspaceRoot)) {
            throw this.failure(`No saved graph found at ${DEFAULT_RUNTIME_GRAPH_PATH}`);
        }
        const graph = this.readArtifact(DEFAULT_RUNTIME_GRAPH_PATH, () =>
            loadRuntimeGraph(workspaceRoot),
        );
        this.validateRuntime(graph);
        return graph;
    }

    private readArtifact<T>(graphPath: string, load: () => T): T {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- saved JSON decoding boundary adds the artifact path and repair while preserving the cause
        try {
            return load();
        } catch (err: unknown) {
            const error = toError(err);
            if (error instanceof RuleFailError) throw error;
            throw this.failure(
                `Failed to read saved graph at ${graphPath}: ${error.message}`,
                error,
            );
        }
    }

    private failure(message: string, cause?: Error): RuleFailError {
        return new RuleFailError(
            'saved-architecture-snapshot',
            message,
            undefined,
            undefined,
            [new Option(this.refresh(), true)],
            undefined,
            cause,
        );
    }

    // webpieces-disable no-any-unknown -- saved JSON is untrusted until its shape has been checked
    private isMap(value: unknown): boolean {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    validateProjects(graph: EnhancedGraph, graphPath: string): void {
        if (
            !this.isMap(graph) ||
            Object.values(graph).some(
                (entry) =>
                    !this.isMap(entry) ||
                    !Number.isFinite(entry.level) ||
                    !Array.isArray(entry.dependsOn) ||
                    entry.dependsOn.some((dep: string) => typeof dep !== 'string') ||
                    // Optional (#1179): absent in a file written before products existed.
                    (entry.products !== undefined &&
                        (!Array.isArray(entry.products) ||
                            entry.products.some((product: string) => typeof product !== 'string'))),
            )
        ) {
            throw this.failure(
                `Unusable saved project graph at ${graphPath}: expected projects with numeric level, string dependsOn arrays and (when present) string products arrays`,
            );
        }
    }

    validateRuntime(graph: RuntimeGraph | null): asserts graph is RuntimeGraph {
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
            throw this.failure(
                `Unusable saved runtime graph at ${DEFAULT_RUNTIME_GRAPH_PATH}: expected services, apis, queues and runtimeEdges, unresolvedUses, triggers arrays`,
            );
        }
    }
}
