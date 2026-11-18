/**
 * Architecture Markdown
 *
 * Two compact, COMMITTED views of the architecture JSON (#1429), written so an agent can read the
 * whole build graph and the whole runtime graph for a few thousand tokens instead of the ~100k the
 * JSON costs on a large repo:
 *
 *  - `architecture/build-deps.md`  — one line per project, deepest level first:
 *        `<dir> [<role> L<level>]: dep1, dep2`
 *  - `architecture/runtime-deps.md` — service calls, triggers, outbound calls and services.
 *
 * Both are a PURE transform of the committed `dependencies.json` + `runtime-dependencies.json`: no nx
 * graph, no scan. `architecture:generate` writes them right after the JSON, and
 * `validate-architecture-unchanged` re-renders them from the committed JSON and fails on any
 * difference, so the views can never silently disagree with the record they summarize.
 *
 * Every `*Via` / wiring provenance string is deliberately left out — it stays in the JSON for the
 * reviewers and validators that need it, and is most of what makes the JSON expensive to read.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Option, RuleFailError } from '@webpieces/rules-config';
import { DEFAULT_GRAPH_PATH, loadBlessedGraph } from './graph-loader';
import type { DependenciesFile } from './graph-loader';
import type { GraphEntry } from './graph-sorter';
import { GraphNames } from './graph-names';
import { loadRuntimeGraph } from './runtime-graph-io';
import type {
    RuntimeEdge,
    RuntimeExternalSystem,
    RuntimeGraph,
    RuntimeRemoteCall,
    RuntimeRemoteService,
    RuntimeService,
    RuntimeTrigger,
} from './runtime-graph-model';

export const BUILD_DEPS_FILE = 'build-deps.md';
export const RUNTIME_DEPS_FILE = 'runtime-deps.md';
export const REGENERATE_COMMAND = 'pnpm nx run architecture:generate';
const RESPONSIBILITIES_FILE = 'responsibilities.md';
const VALIDATE_RULE = 'validate-architecture-unchanged';

/** The two rendered views. `runtimeDeps` is null when there is no runtime graph to render. */
export class ArchitectureMarkdown {
    constructor(
        public readonly buildDeps: string,
        public readonly runtimeDeps: string | null,
    ) {}
}

/** One rendered file that does not match the committed JSON: its repo-relative path and why. */
export class MarkdownDrift {
    constructor(
        public readonly file: string,
        public readonly reason: 'missing' | 'differs',
    ) {}
}

/**
 * The display name of every project, derived ONCE so both files name a project identically.
 *
 * A name is the project key with its `@scope/` stripped ({@link GraphNames.getShortName}) — unless two
 * keys strip to the same short name, in which case both keep their full key: a short name in these
 * files must identify exactly one project.
 */
export class ProjectDisplayNames {
    private readonly ambiguous: Set<string>;

    constructor(
        keys: Iterable<string>,
        private readonly names: GraphNames = new GraphNames(),
    ) {
        const owners = new Map<string, Set<string>>();
        for (const key of keys) {
            const short = this.names.getShortName(key);
            const set = owners.get(short) ?? new Set<string>();
            set.add(key);
            owners.set(short, set);
        }
        this.ambiguous = new Set(
            [...owners.entries()].filter((e: [string, Set<string>]): boolean => e[1].size > 1).map((e: [string, Set<string>]): string => e[0]),
        );
    }

    of(key: string): string {
        const short = this.names.getShortName(key);
        return this.ambiguous.has(short) ? key : short;
    }
}

/** Renders `build-deps.md` from the committed dependencies.json. */
export class BuildDepsRenderer {
    render(deps: DependenciesFile, names: ProjectDisplayNames): string {
        const keys = Object.keys(deps.projects);
        const rows = keys.map((key: string): BuildRow => this.row(key, deps.projects[key], names));
        rows.sort((a: BuildRow, b: BuildRow): number => b.level - a.level || compare(a.label, b.label));
        const offConvention = rows.filter((row: BuildRow): boolean => row.offConventionPath !== null);
        const lines: string[] = [
            '# Build dependencies (generated — do not edit)',
            '',
            `Generated from \`dependencies.json\` by \`${REGENERATE_COMMAND}\`; the JSON stays the source for queries.`,
            'One line per project, deepest level first: `<dir> [<role> L<level>]: <deps>` (`-` = none).',
            'A dep is a project name: the last segment of its `<dir>`, unless its line reads `<dir> (<name>)`.',
            `Before adding code to a project, read \`<dir>/${RESPONSIBILITIES_FILE}\` (exceptions are indexed at the end).`,
            '',
            '```text',
            ...rows.map((row: BuildRow): string => row.text),
            '```',
        ];
        if (offConvention.length > 0) {
            lines.push('', `## Responsibilities files not at \`<dir>/${RESPONSIBILITIES_FILE}\``, '', '```text');
            const index = offConvention.map((row: BuildRow): string => `${row.name}=${row.offConventionPath}`);
            lines.push(...index.sort(compare), '```');
        }
        return lines.join('\n') + '\n';
    }

    private row(key: string, entry: GraphEntry, names: ProjectDisplayNames): BuildRow {
        const name = names.of(key);
        const file = entry.responsibilitiesFile;
        const dir = file === undefined ? null : path.posix.dirname(file.replace(/\\/g, '/'));
        // The line is keyed by directory; the name is spelled out only when the dir does not imply it.
        const label = dir === null ? name : path.posix.basename(dir) === name ? dir : `${dir} (${name})`;
        const offConvention =
            file === undefined ? '-' : path.posix.basename(file) === RESPONSIBILITIES_FILE ? null : file;
        const role = entry.role === undefined ? '' : `${entry.role} `;
        const depNames = [...entry.dependsOn].map((dep: string): string => names.of(dep)).sort(compare);
        const depText = depNames.length === 0 ? '-' : depNames.join(', ');
        return new BuildRow(label, name, entry.level, offConvention, `${label} [${role}L${entry.level}]: ${depText}`);
    }
}

/** One project's line in build-deps.md, plus what the fallback index needs. Data only. */
class BuildRow {
    constructor(
        public readonly label: string,
        public readonly name: string,
        public readonly level: number,
        /** Its responsibilities file when it breaks the `<dir>/responsibilities.md` convention, '-' when it has none. */
        public readonly offConventionPath: string | null,
        public readonly text: string,
    ) {}
}

/** Renders `runtime-deps.md` from the committed runtime-dependencies.json. */
export class RuntimeDepsRenderer {
    render(graph: RuntimeGraph, names: ProjectDisplayNames): string {
        const lines: string[] = [
            '# Runtime dependencies (generated — do not edit)',
            '',
            `Generated from \`runtime-dependencies.json\` by \`${REGENERATE_COMMAND}\`; the JSON stays the source for queries.`,
            'Covers webpieces services only. Calls to or from non-webpieces services are not shown, so a missing edge',
            'means "not modelled", not "no call"; the outside callees we do know of are under "Not modelled here".',
            'Names are project names, as in `build-deps.md`.',
        ];
        this.section(lines, 'Service calls', this.serviceCalls(graph, names));
        this.section(lines, 'Triggers', this.triggers(graph, names));
        this.section(lines, 'Not modelled here (outbound calls to remote services, external systems and unresolved APIs)', this.outbound(graph, names));
        this.section(lines, 'Services', this.services(graph, names));
        return lines.join('\n') + '\n';
    }

    private section(lines: string[], title: string, body: string[]): void {
        lines.push('', `## ${title}`, '', '```text', ...(body.length === 0 ? ['-'] : body), '```');
    }

    private serviceCalls(graph: RuntimeGraph, names: ProjectDisplayNames): string[] {
        return graph.runtimeEdges.map((edge: RuntimeEdge): string => {
            const type = edge.type ?? 'rpc';
            const queue = edge.queue === undefined ? '' : ` queue=${graph.queues[edge.queue]?.queueName ?? edge.queue}`;
            const cut = edge.cutLegacyCycle === true ? ' (legacy cycle)' : '';
            const via = [...edge.via].sort(compare).join(', ');
            return `${names.of(edge.from)} -${type}-> ${names.of(edge.to)} [${via}]${queue}${cut}`;
        }).sort(compare);
    }

    private triggers(graph: RuntimeGraph, names: ProjectDisplayNames): string[] {
        return graph.triggers.map((trigger: RuntimeTrigger): string => {
            const detail: string[] = [];
            if (trigger.queueName !== undefined) detail.push(trigger.queueName);
            if (trigger.caller !== undefined) detail.push(`from ${trigger.caller.kind} ${trigger.caller.label}`);
            const suffix = detail.length === 0 ? '' : ` (${detail.join('; ')})`;
            return `${trigger.kind} ${names.of(trigger.service)}.${trigger.api}.${trigger.method}${suffix}`;
        }).sort(compare);
    }

    private outbound(graph: RuntimeGraph, names: ProjectDisplayNames): string[] {
        const lines: string[] = [];
        for (const use of graph.unresolvedUses) {
            const owner = graph.apis[use.api]?.owner;
            lines.push(`${names.of(use.service)} -> ${use.api}${owner === undefined ? '' : ` (owner ${names.of(owner)})`}`);
        }
        for (const system of Object.values(graph.externalSystems ?? {})) lines.push(...this.externalSystem(system, names));
        for (const [remote, service] of Object.entries(graph.remoteServices ?? {})) lines.push(...this.remoteService(remote, service, names));
        return lines.sort(compare);
    }

    private externalSystem(system: RuntimeExternalSystem, names: ProjectDisplayNames): string[] {
        const apis = system.apis.length === 0 ? '' : ` [${[...system.apis].sort(compare).join(', ')}]`;
        return system.usedBy.map((user: string): string => `${names.of(user)} -> ${system.kind} ${system.label}${apis}`);
    }

    private remoteService(remote: string, service: RuntimeRemoteService, names: ProjectDisplayNames): string[] {
        return service.calledBy.map((call: RuntimeRemoteCall): string => {
            const via = [...call.via].sort(compare).join(', ');
            return `${names.of(call.from)} -${call.type}-> ${remote} [${via}] (remote service)`;
        });
    }

    private services(graph: RuntimeGraph, names: ProjectDisplayNames): string[] {
        const keys = Object.keys(graph.services);
        keys.sort((a: string, b: string): number =>
            graph.services[b].level - graph.services[a].level || compare(names.of(a), names.of(b)));
        return keys.map((key: string): string => {
            const service: RuntimeService = graph.services[key];
            const role = service.role === undefined ? '' : `${service.role} `;
            const apis = service.implements.length === 0 ? '-' : [...service.implements].sort(compare).join(', ');
            return `${names.of(key)} [${role}L${service.level}]: ${apis}`;
        });
    }
}

/** DependenciesFile + RuntimeGraph -> the two markdown strings. Pure: no IO. */
export class ArchitectureMarkdownRenderer {
    constructor(
        private readonly build: BuildDepsRenderer = new BuildDepsRenderer(),
        private readonly runtime: RuntimeDepsRenderer = new RuntimeDepsRenderer(),
    ) {}

    render(deps: DependenciesFile, runtime: RuntimeGraph | null): ArchitectureMarkdown {
        const keys = new Set<string>(Object.keys(deps.projects));
        for (const key of Object.keys(runtime?.services ?? {})) keys.add(key);
        const names = new ProjectDisplayNames(keys);
        return new ArchitectureMarkdown(
            this.build.render(deps, names),
            runtime === null ? null : this.runtime.render(runtime, names),
        );
    }
}

/**
 * Reads the COMMITTED JSON, and writes (generate) or checks (validate-architecture-unchanged) the two
 * markdown views beside `dependencies.json`. Both sides render from the files on disk, never from an
 * in-memory graph, so generate and validate cannot render differently.
 */
export class ArchitectureMarkdownFiles {
    constructor(private readonly renderer: ArchitectureMarkdownRenderer = new ArchitectureMarkdownRenderer()) {}

    /** Write both views from the committed JSON. Returns the repo-relative paths written. */
    write(workspaceRoot: string, graphPath: string = DEFAULT_GRAPH_PATH): string[] {
        const written: string[] = [];
        for (const view of this.expected(workspaceRoot, graphPath)) {
            const full = path.join(workspaceRoot, view.file);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, view.body, 'utf-8');
            written.push(view.file);
        }
        return written;
    }

    /** Every committed view that is missing or differs from the render of the committed JSON. */
    drift(workspaceRoot: string, graphPath: string = DEFAULT_GRAPH_PATH): MarkdownDrift[] {
        const drifts: MarkdownDrift[] = [];
        for (const view of this.expected(workspaceRoot, graphPath)) {
            const full = path.join(workspaceRoot, view.file);
            if (!fs.existsSync(full)) drifts.push(new MarkdownDrift(view.file, 'missing'));
            else if (fs.readFileSync(full, 'utf-8') !== view.body) drifts.push(new MarkdownDrift(view.file, 'differs'));
        }
        return drifts;
    }

    /** Throws the structured RuleFailError naming every drifted file and the regenerate command. */
    assertMatchesCommitted(workspaceRoot: string, graphPath: string = DEFAULT_GRAPH_PATH): void {
        const drifts = this.drift(workspaceRoot, graphPath);
        if (drifts.length === 0) return;
        const listed = drifts.map((d: MarkdownDrift): string => `  ${d.file}: ${d.reason === 'missing' ? 'missing' : 'differs from the render of the committed JSON'}`);
        const files = drifts.map((d: MarkdownDrift): string => d.file).join(' ');
        throw new RuleFailError(
            VALIDATE_RULE,
            'The generated architecture markdown views do not match the committed architecture JSON:\n' +
                listed.join('\n') +
                '\nThey are generated files: never hand-edit or hand-merge them.',
            undefined,
            undefined,
            [new Option(`Run ${REGENERATE_COMMAND}, then commit ${files}.`, true)],
        );
    }

    /** The views the committed JSON renders to; no runtime view when there is no runtime graph. */
    private expected(workspaceRoot: string, graphPath: string): ExpectedView[] {
        const deps = loadBlessedGraph(workspaceRoot, graphPath);
        if (deps === null) return [];
        const dir = path.posix.dirname(graphPath.replace(/\\/g, '/'));
        const rendered = this.renderer.render(deps, loadRuntimeGraph(workspaceRoot));
        const views = [new ExpectedView(path.posix.join(dir, BUILD_DEPS_FILE), rendered.buildDeps)];
        if (rendered.runtimeDeps !== null)
            views.push(new ExpectedView(path.posix.join(dir, RUNTIME_DEPS_FILE), rendered.runtimeDeps));
        return views;
    }
}

/** One view's repo-relative path and the exact bytes the committed JSON renders to. Data only. */
class ExpectedView {
    constructor(
        public readonly file: string,
        public readonly body: string,
    ) {}
}

/** Locale-independent string order, so the files are byte-identical on every machine. */
// webpieces-disable no-function-outside-class -- a comparator shared by the renderers above
function compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}
