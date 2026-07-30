/**
 * Runtime Graph persistence
 *
 * Reading, writing and canonical-serializing architecture/runtime-dependencies.json. Split out of
 * runtime-graph.ts (which owns the derivation and had grown past the file-size limit).
 *
 * `formatRuntimeJson` is the ONE canonical rendering: validate-runtime-architecture compares the
 * freshly derived graph to the committed one as STRINGS, so any second way of writing this file
 * would show up as unfixable drift.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RuntimeGraph } from './runtime-graph-model';
import { toError } from '../toError';

export const DEFAULT_RUNTIME_GRAPH_PATH = 'architecture/runtime-dependencies.json';

/** Deterministic JSON (sorted keys + arrays already sorted during assembly). */
// webpieces-disable no-function-outside-class -- module-scope file IO, matching saveGraph/loadBlessedGraph in graph-loader.ts
function formatRuntimeJson(graph: RuntimeGraph): string {
    return JSON.stringify(graph, null, 4) + '\n';
}

// webpieces-disable no-function-outside-class -- module-scope file IO, matching saveGraph/loadBlessedGraph in graph-loader.ts
export function saveRuntimeGraph(
    graph: RuntimeGraph,
    workspaceRoot: string,
    graphPath: string = DEFAULT_RUNTIME_GRAPH_PATH,
): void {
    const fullPath = path.join(workspaceRoot, graphPath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, formatRuntimeJson(graph), 'utf-8');
}

// webpieces-disable no-function-outside-class -- module-scope file IO, matching saveGraph/loadBlessedGraph in graph-loader.ts
export function runtimeGraphFileExists(
    workspaceRoot: string,
    graphPath: string = DEFAULT_RUNTIME_GRAPH_PATH,
): boolean {
    return fs.existsSync(path.join(workspaceRoot, graphPath));
}

// webpieces-disable no-function-outside-class -- module-scope file IO, matching saveGraph/loadBlessedGraph in graph-loader.ts
export function loadRuntimeGraph(
    workspaceRoot: string,
    graphPath: string = DEFAULT_RUNTIME_GRAPH_PATH,
): RuntimeGraph | null {
    const fullPath = path.join(workspaceRoot, graphPath);
    if (!fs.existsSync(fullPath)) return null;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as RuntimeGraph;
    } catch (err: unknown) {
        const error = toError(err);
        throw new Error(`Failed to load runtime graph from ${fullPath}`, { cause: error });
    }
}

/** Serialize for an in-memory equality check (matches the on-disk format). */
// webpieces-disable no-function-outside-class -- module-scope file IO, matching saveGraph/loadBlessedGraph in graph-loader.ts
export function serializeRuntimeGraph(graph: RuntimeGraph): string {
    return formatRuntimeJson(graph);
}
