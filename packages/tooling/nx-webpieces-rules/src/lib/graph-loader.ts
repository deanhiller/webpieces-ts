/**
 * Graph Loader
 *
 * Handles loading and saving the blessed dependency graph file.
 * The graph is stored at architecture/dependencies.json in the workspace root.
 *
 * File format (schema aimed at AI consumers):
 * {
 *     "aiInstructions": "...how AI should use the per-project fields...",
 *     "projects": {
 *         "<project>": { level, framework, shortDescription,
 *                        responsibilitiesFile, designFile, dependsOn }
 *     }
 * }
 *
 * `framework` is the project's libType — which client side it targets:
 * angular | react | express | all ("all" = usable by any side). It comes from
 * the project's `framework:` nx tag and is enforced across edges by the
 * `library-types-match-client` rule.
 *
 * The legacy format (flat { "<project>": { level, dependsOn } } map) is still
 * readable so validation against a pre-upgrade file produces a clean
 * "re-run architecture:generate" diff instead of a parse failure.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { EnhancedGraph, GraphEntry } from './graph-sorter';
import { toError } from '../toError';

/**
 * Default path for the dependencies file (relative to workspace root)
 */
export const DEFAULT_GRAPH_PATH = 'architecture/dependencies.json';

/**
 * Top-level instructions embedded in dependencies.json telling AI how to use
 * the per-project metadata fields.
 */
export const AI_INSTRUCTIONS =
    "Each project's shortDescription is only a summary. BEFORE adding code to a project, " +
    'read its responsibilitiesFile for the full responsibilities (what belongs in that ' +
    'project and what does not), and read its designFile to understand the DI design ' +
    'before reading the code. Use the entries in `commands` to regenerate these files ' +
    'or display any of the graphs in a browser.';

/**
 * Named command → "command — what it does" map embedded in dependencies.json.
 */
export type CommandMap = Record<string, string>;

/**
 * Commands embedded in dependencies.json so AI (and humans) know how to
 * regenerate and DISPLAY the architecture + design graphs. These work in any
 * repo consuming @webpieces/nx-webpieces-rules.
 */
export const GRAPH_COMMANDS: CommandMap = {
    regenerateArchitecture:
        'pnpm nx run architecture:generate — rewrites architecture/dependencies.json and ' +
        'architecture/runtime-dependencies.json; run after adding/removing project dependencies',
    visualizeArchitecture:
        'pnpm nx run architecture:visualize — opens the monorepo dependency graph (this file) ' +
        'as HTML in a browser',
    visualizeRuntimeArchitecture:
        'pnpm nx run architecture:visualize-runtime — opens the runtime microservice call graph ' +
        'as HTML in a browser',
    regenerateDesigns:
        "pnpm nx run-many --target=di-graph-generate — rewrites every project's " +
        'design.json/design.md (also runs automatically on every build)',
    visualizeDesign:
        "pnpm wp-design-visualize <project> — opens a project's DI designs (its designFile) as " +
        'HTML, one graph per controller with the controller at the top; no args = interactive picker',
};

/**
 * The full contents of architecture/dependencies.json.
 */
export class DependenciesFile {
    constructor(
        public readonly aiInstructions: string,
        public readonly commands: CommandMap,
        public readonly projects: EnhancedGraph
    ) {}
}

/**
 * Load the blessed graph from disk. Understands both the current wrapper
 * format and the legacy flat map (which loads with empty aiInstructions).
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @param graphPath - Relative path to graph file (default: architecture/dependencies.json)
 * @returns The blessed graph file, or null if it doesn't exist
 */
export function loadBlessedGraph(
    workspaceRoot: string,
    graphPath: string = DEFAULT_GRAPH_PATH
): DependenciesFile | null {
    const fullPath = path.join(workspaceRoot, graphPath);

    if (!fs.existsSync(fullPath)) {
        return null;
    }

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const parsed = JSON.parse(content);
        if (parsed !== null && typeof parsed === 'object' && 'projects' in parsed) {
            return new DependenciesFile(
                typeof parsed.aiInstructions === 'string' ? parsed.aiInstructions : '',
                parsed.commands !== null && typeof parsed.commands === 'object' ? (parsed.commands as CommandMap) : {},
                parsed.projects as EnhancedGraph
            );
        }
        // Legacy flat format: the whole object is the project map
        return new DependenciesFile('', {}, parsed as EnhancedGraph);
    } catch (err: unknown) {
        const error = toError(err);
        throw new Error(`Failed to load graph from ${fullPath}`, { cause: error });
    }
}

/**
 * Format the dependencies file as JSON with multi-line arrays for readability
 */
function formatGraphJson(file: DependenciesFile): string {
    const lines: string[] = ['{'];
    lines.push(`    "aiInstructions": ${JSON.stringify(file.aiInstructions)},`);
    lines.push(`    "commands": {`);
    const commandNames = Object.keys(file.commands);
    commandNames.forEach((name: string, index: number) => {
        const comma = index === commandNames.length - 1 ? '' : ',';
        lines.push(`        ${JSON.stringify(name)}: ${JSON.stringify(file.commands[name])}${comma}`);
    });
    lines.push(`    },`);
    lines.push(`    "projects": {`);

    const keys = Object.keys(file.projects).sort();
    keys.forEach((key: string, index: number) => {
        const entry = file.projects[key];
        const isLast = index === keys.length - 1;
        const comma = isLast ? '' : ',';

        lines.push(`        ${JSON.stringify(key)}: {`);
        lines.push(...formatEntryLines(entry));
        lines.push(`        }${comma}`);
    });

    lines.push('    }');
    lines.push('}');
    return lines.join('\n') + '\n';
}

/**
 * Format one project entry's fields (12-space indent). Optional metadata
 * fields are only emitted when present.
 */
function formatEntryLines(entry: GraphEntry): string[] {
    const lines: string[] = [];
    lines.push(`            "level": ${entry.level},`);

    pushOptionalField(lines, 'framework', entry.framework);
    pushOptionalField(lines, 'shortDescription', entry.shortDescription);
    pushOptionalField(lines, 'responsibilitiesFile', entry.responsibilitiesFile);
    pushOptionalField(lines, 'designFile', entry.designFile);

    if (entry.dependsOn.length === 0) {
        lines.push(`            "dependsOn": []`);
    } else {
        lines.push(`            "dependsOn": [`);
        entry.dependsOn.forEach((dep: string, depIndex: number) => {
            const depComma = depIndex === entry.dependsOn.length - 1 ? '' : ',';
            lines.push(`                ${JSON.stringify(dep)}${depComma}`);
        });
        lines.push(`            ]`);
    }
    return lines;
}

/**
 * Emit one optional string field (12-space indent), skipped when undefined.
 */
function pushOptionalField(lines: string[], field: string, value: string | undefined): void {
    if (value !== undefined) {
        lines.push(`            ${JSON.stringify(field)}: ${JSON.stringify(value)},`);
    }
}

/**
 * Save the graph to disk in the wrapper format with the standard aiInstructions.
 *
 * @param graph - The enriched project graph to save
 * @param workspaceRoot - Absolute path to workspace root
 * @param graphPath - Relative path to graph file (default: architecture/dependencies.json)
 */
export function saveGraph(
    graph: EnhancedGraph,
    workspaceRoot: string,
    graphPath: string = DEFAULT_GRAPH_PATH
): void {
    const fullPath = path.join(workspaceRoot, graphPath);
    const dir = path.dirname(fullPath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Sort keys for deterministic output
    const sortedGraph: EnhancedGraph = {};
    const sortedKeys = Object.keys(graph).sort();
    for (const key of sortedKeys) {
        sortedGraph[key] = graph[key];
    }

    const content = formatGraphJson(new DependenciesFile(AI_INSTRUCTIONS, GRAPH_COMMANDS, sortedGraph));
    fs.writeFileSync(fullPath, content, 'utf-8');
}

/**
 * Check if the graph file exists
 */
export function graphFileExists(
    workspaceRoot: string,
    graphPath: string = DEFAULT_GRAPH_PATH
): boolean {
    const fullPath = path.join(workspaceRoot, graphPath);
    return fs.existsSync(fullPath);
}
