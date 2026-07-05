/**
 * DI Graph Generate Executor
 *
 * Per-project: statically analyzes the project's Inversify dependency DAG
 * (constructor injection from controllers — or library top-of-DAG classes —
 * down to leaves) and writes two checked-in files at the project root:
 *
 *   design.json — machine-readable graph (deterministic, sorted)
 *   design.md   — Mermaid diagram rendered by GitHub/IDEs in PRs
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
import { loadAndValidate } from '@webpieces/rules-config';
import * as fs from 'fs';
import * as path from 'path';
import {
    DiAnalyzer,
    explicitFrameworkTag,
    explicitRoleTag,
    FrameworkMarkers,
    selectAnalyzer,
} from '../../lib/di-graph/analyzer-strategy';
import { createProjectProgram } from '../../lib/di-graph/program';
import { toDesignJson } from '../../lib/di-graph/serializer';
import { toDesignMarkdown } from '../../lib/di-graph/mermaid';
import { DiDesign, DiGraph } from '../../lib/di-graph/model';
import { toError } from '../../toError';

export interface DiGraphGenerateOptions {
    // No options here — config comes from webpieces.config.json at runtime.
}

export interface ExecutorResult {
    success: boolean;
}

const RULE_NAME = 'di-graph';

// Cheap substring pre-scan: a project whose source never mentions any DI marker
// gets an empty graph without paying for a ts.Program. Angular markers
// (@Component/bootstrapApplication) are included so an Angular app that uses no
// Inversify decorator isn't short-circuited to empty.
const DI_MARKERS = [
    '@Controller(',
    '@ApiImplementation(',
    '@provideSingleton',
    '@provideTransient',
    '@injectable',
    'new ContainerModule',
    '@inject(',
    '@Component(',
    'bootstrapApplication',
];

const ANGULAR_MARKERS = ['@Component(', 'bootstrapApplication'];
const CONTROLLER_MARKER = '@Controller(';

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
        if (!controller && content.includes(CONTROLLER_MARKER)) controller = true;
    });
    return new FrameworkMarkers(angular, controller);
}

function writeDesignFiles(projectRootAbs: string, graph: DiGraph): void {
    fs.writeFileSync(path.join(projectRootAbs, 'design.json'), toDesignJson(graph));
    fs.writeFileSync(path.join(projectRootAbs, 'design.md'), toDesignMarkdown(graph));
}

/** The analyzer chosen for a project plus the role tag that drove the choice. */
class AnalyzerChoice {
    constructor(
        public readonly analyzer: DiAnalyzer,
        public readonly role: string | null,
    ) {}
}

/**
 * Select the analyzer by role (server→@Controller, designed-lib→@ApiImplementation,
 * client→angular design, lib→skip). The explicit `role:` nx tag is the source of
 * truth; when absent we fall back to the legacy `framework:` selection + marker
 * pre-scan so designs stay identical until a project is retagged.
 */
function chooseAnalyzer(tags: string[], srcDir: string): AnalyzerChoice {
    const role = explicitRoleTag(tags);
    const framework = explicitFrameworkTag(tags);
    const analyzer = selectAnalyzer(role, framework, detectFrameworkMarkers(srcDir));
    console.log(
        `   Analyzer: ${analyzer.constructor.name} ` +
            `(role tag: ${role ?? 'none'}, framework tag: ${framework ?? 'none'})`,
    );
    return new AnalyzerChoice(analyzer, role);
}

function reportDesignedLibMissingRoot(projectName: string): void {
    console.error(
        `❌ ${projectName} is tagged role:designed-lib but has no @ApiImplementation class.\n` +
            `   Annotate the library's top implementation class with @ApiImplementation ` +
            `(from @webpieces/http-routing), or retag the project role:lib if it has no design.`,
    );
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
            writeDesignFiles(projectRootAbs, new DiGraph(projectName));
            return { success: true };
        }

        const program = createProjectProgram(projectRootAbs);
        if (!program) {
            console.log('   No usable tsconfig/source — writing empty design graph');
            writeDesignFiles(projectRootAbs, new DiGraph(projectName));
            return { success: true };
        }

        const choice = chooseAnalyzer(projectConfig?.tags ?? [], srcDir);
        const graph = choice.analyzer.analyzeProject(program, context.root, projectRoot, projectName);

        // A designed-lib MUST expose at least one @ApiImplementation root, else its
        // design would be empty and the tag is meaningless — fail loudly.
        if (choice.role === 'designed-lib' && graph.designs.length === 0) {
            reportDesignedLibMissingRoot(projectName);
            return { success: false };
        }

        writeDesignFiles(projectRootAbs, graph);

        const nodeCount = graph.designs.reduce((sum: number, d: DiDesign) => sum + d.nodes.length, 0);
        const edgeCount = graph.designs.reduce((sum: number, d: DiDesign) => sum + d.edges.length, 0);
        console.log(
            `✅ Wrote ${projectRoot}/design.json + design.md ` +
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
