/**
 * DI Graph Generate Executor
 *
 * Per-project: statically analyzes the project's Inversify dependency DAG
 * (constructor injection from controllers — or library top-of-DAG classes —
 * down to leaves) and writes three checked-in files at the project root:
 *
 *   design.json — machine-readable graph (deterministic, sorted)
 *   design.md   — Mermaid diagram rendered by GitHub/IDEs in PRs
 *   design.html — clickable viz.js page (linked from architecture/dependencies.html)
 *
 * Runs on every build (cache:false; the build gates on
 * validate-di-graph-unchanged which dependsOn this target). Unrecognized DI
 * patterns become "unresolved" nodes rather than failing the build.
 *
 * Config (webpieces.config.json, rule key `di-graph`): mode RUN_EVERY_TIME | OFF.
 *
 * Usage: nx run <project>:di-graph-generate
 */

import type { ExecutorContext } from '@nx/devkit';
import { loadAndValidate, ResolvedConfig } from '@webpieces/rules-config';
import * as fs from 'fs';
import * as path from 'path';
import {
    DiAnalyzer,
    frameworkTags,
    explicitRoleTag,
    FrameworkMarkers,
    selectAnalyzer,
} from '../../lib/di-graph/analyzer-strategy';
import { createProjectProgram } from '../../lib/di-graph/program';
import { toDesignJson } from '../../lib/di-graph/serializer';
import { toDesignMarkdown } from '../../lib/di-graph/mermaid';
import { generateDesignHTML } from '../../lib/di-graph/design-visualizer';
import { DiDesign, DiGraph } from '../../lib/di-graph/model';
import { toError } from '../../toError';

export interface DiGraphGenerateOptions {
    // No options here — config comes from webpieces.config.json at runtime.
}

export interface ExecutorResult {
    success: boolean;
}

const RULE_NAME = 'di-graph';
const MISSING_DESIGN_RULE_NAME = 'missing-design-annotation';

// Cheap substring pre-scan: a project whose source never mentions any DI marker
// gets an empty graph without paying for a ts.Program. Angular markers
// (@Component/bootstrapApplication) are included so an Angular app that uses no
// Inversify decorator isn't short-circuited to empty.
const DI_MARKERS = [
    '@DocumentDesign(',
    '@provideSingleton',
    '@provideTransient',
    '@injectable',
    'new ContainerModule',
    '@inject(',
    '@Component(',
    'bootstrapApplication',
];

const ANGULAR_MARKERS = ['@Component(', 'bootstrapApplication'];
// A non-Angular DI-design root. When no role tag is set, its presence steers the
// marker-fallback toward the Inversify analyzer (server/controller mode).
const DESIGN_ROOT_MARKER = '@DocumentDesign(';

/** Recursively read every project .ts file, folding each into `visit`. */
function forEachSourceFile(dir: string, visit: (content: string) => void): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist') continue;
            forEachSourceFile(full, visit);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            visit(fs.readFileSync(full, 'utf-8'));
        }
    }
}

function sourceHasDiMarkers(dir: string): boolean {
    let found = false;
    forEachSourceFile(dir, (content: string) => {
        if (!found && DI_MARKERS.some((marker: string) => content.includes(marker))) found = true;
    });
    return found;
}

/** Pre-scan a project's source for the framework markers used when no tag is set. */
function detectFrameworkMarkers(dir: string): FrameworkMarkers {
    let angular = false;
    let controller = false;
    forEachSourceFile(dir, (content: string) => {
        if (!angular && ANGULAR_MARKERS.some((marker: string) => content.includes(marker))) angular = true;
        if (!controller && content.includes(DESIGN_ROOT_MARKER)) controller = true;
    });
    return new FrameworkMarkers(angular, controller);
}

/**
 * Repo-relative back link from a project's committed design.html up to
 * architecture/dependencies.html, so a reader who clicked a box in the
 * architecture graph can click back out. E.g. 'packages/http/http-api' →
 * '../../../architecture/dependencies.html'.
 */
function architectureBackHref(projectRoot: string): string {
    return path.posix.relative(projectRoot.replace(/\\/g, '/'), 'architecture/dependencies.html');
}

function writeDesignFiles(projectRootAbs: string, projectRoot: string, graph: DiGraph): void {
    // toDesignJson sorts the graph in place, so design.md/design.html below all
    // see the same deterministic ordering (no git churn on re-run).
    fs.writeFileSync(path.join(projectRootAbs, 'design.json'), toDesignJson(graph));
    fs.writeFileSync(path.join(projectRootAbs, 'design.md'), toDesignMarkdown(graph));
    fs.writeFileSync(
        path.join(projectRootAbs, 'design.html'),
        generateDesignHTML(graph, architectureBackHref(projectRoot)),
    );
}

/** The analyzer chosen for a project plus the role tag that drove the choice. */
class AnalyzerChoice {
    constructor(
        public readonly analyzer: DiAnalyzer,
        public readonly role: string | null,
    ) {}
}

/**
 * Select the analyzer by role (server & designed-lib → @DocumentDesign,
 * client→angular design, lib→skip). The explicit `role:` nx tag is the source of
 * truth; when absent we fall back to the legacy `framework:` selection + marker
 * pre-scan so designs stay identical until a project is retagged.
 */
function chooseAnalyzer(tags: string[], srcDir: string): AnalyzerChoice {
    const role = explicitRoleTag(tags);
    const frameworks = frameworkTags(tags);
    const analyzer = selectAnalyzer(role, frameworks, detectFrameworkMarkers(srcDir));
    console.log(
        `   Analyzer: ${analyzer.constructor.name} ` +
            `(role tag: ${role ?? 'none'}, framework tags: ${frameworks.length > 0 ? frameworks.join(', ') : 'none'})`,
    );
    return new AnalyzerChoice(analyzer, role);
}

/**
 * A server/designed-lib project that produced no design (zero @DocumentDesign
 * roots) fails the build with role-specific guidance. Enforced under the
 * `missing-design-annotation` rule.
 */
function reportMissingDesignAnnotation(projectName: string, role: string): void {
    if (role === 'server') {
        console.error(
            `❌ ${projectName} is tagged role:server but has no @DocumentDesign class.\n` +
                `   All controllers should be annotated with @DocumentDesign() ` +
                `(from @webpieces/http-routing) so their design.json / design.html get generated\n` +
                `   and linked from architecture/dependencies.html.`,
        );
        return;
    }
    console.error(
        `❌ ${projectName} is tagged role:designed-lib but has no @DocumentDesign class.\n` +
            `   One or more classes you want a design printed for need @DocumentDesign() ` +
            `(from @webpieces/http-routing) added —\n` +
            `   or retag the project role:lib if it has no design.`,
    );
}

/**
 * A server/designed-lib project MUST expose at least one @DocumentDesign root,
 * else its design is empty and the role is meaningless. Returns true (and reports)
 * when the build should fail. The `missing-design-annotation` rule gates it:
 * absent (an older published config) → enforce; OFF → skip.
 */
function failsMissingDesignAnnotation(
    shared: ResolvedConfig,
    role: string | null,
    graph: DiGraph,
    projectName: string,
): boolean {
    const missingRule = shared.rules.get(MISSING_DESIGN_RULE_NAME);
    const enforce = !missingRule || !missingRule.isOff;
    if (enforce && graph.designs.length === 0 && (role === 'server' || role === 'designed-lib')) {
        reportMissingDesignAnnotation(projectName, role);
        return true;
    }
    return false;
}

export default async function runExecutor(
    _options: DiGraphGenerateOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    const shared = loadAndValidate(context.root).resolved;
    const rule = shared.rules.get(RULE_NAME);
    if (rule && rule.isOff) {
        console.log(`\n⏭️  Skipping ${RULE_NAME} generation (mode: OFF)\n`);
        return { success: true };
    }

    const projectName = context.projectName ?? 'project';
    const projectConfig = context.projectsConfigurations?.projects[projectName];
    const projectRoot = projectConfig?.root ?? '.';
    const projectRootAbs = path.join(context.root, projectRoot);
    const srcDir = path.join(projectRootAbs, 'src');

    console.log(`\n🧬 Generating DI design graph for ${projectName}\n`);

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- chokepoint: a generator crash must produce an actionable failure, not a stack trace mid-build
    try {
        if (!sourceHasDiMarkers(srcDir)) {
            console.log('   No DI markers found — writing empty design graph');
            writeDesignFiles(projectRootAbs, projectRoot, new DiGraph(projectName));
            return { success: true };
        }

        const program = createProjectProgram(projectRootAbs);
        if (!program) {
            console.log('   No usable tsconfig/source — writing empty design graph');
            writeDesignFiles(projectRootAbs, projectRoot, new DiGraph(projectName));
            return { success: true };
        }

        const choice = chooseAnalyzer(projectConfig?.tags ?? [], srcDir);
        const graph = choice.analyzer.analyzeProject(program, context.root, projectRoot, projectName);

        if (failsMissingDesignAnnotation(shared, choice.role, graph, projectName)) {
            return { success: false };
        }

        writeDesignFiles(projectRootAbs, projectRoot, graph);

        const nodeCount = graph.designs.reduce((sum: number, d: DiDesign) => sum + d.nodes.length, 0);
        const edgeCount = graph.designs.reduce((sum: number, d: DiDesign) => sum + d.edges.length, 0);
        console.log(
            `✅ Wrote ${projectRoot}/design.json + design.md + design.html ` +
                `(${graph.designs.length} design(s), ${nodeCount} node(s), ${edgeCount} edge(s))`,
        );
        const unresolved = [...new Set(graph.designs.flatMap((d: DiDesign) => d.unresolved))];
        if (unresolved.length > 0) {
            console.warn(`⚠️  ${unresolved.length} unresolved token(s)/type(s): ${unresolved.join(', ')}`);
        }
        return { success: true };
    } catch (err: unknown) {
        const error = toError(err);
        console.error(`❌ DI graph generation failed for ${projectName}: ${error.message}`);
        console.error(`   To unblock builds, set rules["${RULE_NAME}"].mode="OFF" in webpieces.config.json.`);
        return { success: false };
    }
}
