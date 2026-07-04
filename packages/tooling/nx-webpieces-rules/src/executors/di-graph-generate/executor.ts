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
import { buildDiGraph } from '../../lib/di-graph/analyzer';
import { createProjectProgram } from '../../lib/di-graph/program';
import { toDesignJson } from '../../lib/di-graph/serializer';
import { toDesignMarkdown } from '../../lib/di-graph/mermaid';
import { DiGraph } from '../../lib/di-graph/model';
import { toError } from '../../toError';

export interface DiGraphGenerateOptions {
    // No options here — config comes from webpieces.config.json at runtime.
}

export interface ExecutorResult {
    success: boolean;
}

const RULE_NAME = 'di-graph';

// Cheap substring pre-scan: a project whose source never mentions any DI marker
// gets an empty graph without paying for a ts.Program.
const DI_MARKERS = [
    '@Controller(',
    '@provideSingleton',
    '@provideTransient',
    '@injectable',
    'new ContainerModule',
    '@inject(',
];

function sourceHasDiMarkers(dir: string): boolean {
    if (!fs.existsSync(dir)) return false;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist') continue;
            if (sourceHasDiMarkers(full)) return true;
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            const content = fs.readFileSync(full, 'utf-8');
            if (DI_MARKERS.some((marker: string) => content.includes(marker))) return true;
        }
    }
    return false;
}

function writeDesignFiles(projectRootAbs: string, graph: DiGraph): void {
    fs.writeFileSync(path.join(projectRootAbs, 'design.json'), toDesignJson(graph));
    fs.writeFileSync(path.join(projectRootAbs, 'design.md'), toDesignMarkdown(graph));
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

    console.log(`\n🧬 Generating DI design graph for ${projectName}\n`);

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- chokepoint: a generator crash must produce an actionable failure, not a stack trace mid-build
    try {
        if (!sourceHasDiMarkers(path.join(projectRootAbs, 'src'))) {
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

        const graph = buildDiGraph(program, context.root, projectRoot, projectName);
        writeDesignFiles(projectRootAbs, graph);

        console.log(
            `✅ Wrote ${projectRoot}/design.json + design.md ` +
                `(${graph.roots.length} root(s), ${graph.nodes.length} node(s), ${graph.edges.length} edge(s))`,
        );
        if (graph.unresolved.length > 0) {
            console.warn(`⚠️  ${graph.unresolved.length} unresolved token(s)/type(s): ${graph.unresolved.join(', ')}`);
        }
        return { success: true };
    } catch (err: unknown) {
        const error = toError(err);
        console.error(`❌ DI graph generation failed for ${projectName}: ${error.message}`);
        console.error(`   To unblock builds, set rules["${RULE_NAME}"].mode="OFF" in webpieces.config.json.`);
        return { success: false };
    }
}
