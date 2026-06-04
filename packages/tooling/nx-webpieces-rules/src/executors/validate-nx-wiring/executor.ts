/**
 * Validate Nx Wiring Executor
 *
 * Enforces that the webpieces validators are actually wired into the build. Two checks:
 *
 * 1. nx.json targetDefaults — the compile executors (@nx/js:tsc, @angular/build:application)
 *    must carry the load-bearing dependsOn:
 *      ["architecture:validate-complete", "validate-no-file-import-cycles", "^build"]
 *
 * 2. Per-project override guard — a project that declares its OWN build.dependsOn OVERRIDES
 *    the targetDefaults entirely (nx does not merge dependsOn). That silently drops `^build`
 *    (→ upstream libs not built first, builds against an empty dist) AND the validator gates
 *    (→ the project builds green while validating nothing). So we check each compile project's
 *    RESOLVED build.dependsOn and fail if it is missing any required entry.
 *
 * If either is stripped, validators exist but never run and the build stays green while
 * validating nothing. This executor fails when the wiring is missing.
 *
 * Conservative by design: only REQUIRES wiring on compile executors actually in use
 * (@nx/js:tsc, @angular/build:application). A repo that uses neither passes.
 *
 * Disable via webpieces.config.json rules["nx-wiring"].mode="OFF".
 *
 * Usage: nx run architecture:validate-nx-wiring
 */

import type {
    ExecutorContext,
    ProjectsConfigurations,
    TargetDependencyConfig,
} from '@nx/devkit';
import { createProjectGraphAsync, readProjectsConfigurationFromProjectGraph } from '@nx/devkit';
import { loadConfig } from '@webpieces/rules-config';
import * as fs from 'fs';
import * as path from 'path';

export interface ValidateNxWiringOptions {
    requiredDeps?: string[];
    compileExecutors?: string[];
}

export interface ExecutorResult {
    success: boolean;
}

const DEFAULT_REQUIRED_DEPS: string[] = [
    'architecture:validate-complete',
    'validate-no-file-import-cycles',
];

// Per-project build targets must ALSO keep `^build` so build order follows nx's full graph.
const BUILD_ORDER_DEP = '^build';

const DEFAULT_COMPILE_EXECUTORS: string[] = [
    '@nx/js:tsc',
    '@angular/build:application',
];

class WiringProblem {
    executorName: string;
    missing: string[];
    found: string[];

    constructor(executorName: string, missing: string[], found: string[]) {
        this.executorName = executorName;
        this.missing = missing;
        this.found = found;
    }
}

class ProjectGateProblem {
    project: string;
    executorName: string;
    missing: string[];
    found: string[];

    constructor(project: string, executorName: string, missing: string[], found: string[]) {
        this.project = project;
        this.executorName = executorName;
        this.missing = missing;
        this.found = found;
    }
}

interface TargetDefaultEntry {
    dependsOn?: string[];
}

interface RawNxJson {
    targetDefaults?: Record<string, TargetDefaultEntry>;
}

function readTargetDefaults(workspaceRoot: string): Record<string, TargetDefaultEntry> {
    const nxJsonPath = path.join(workspaceRoot, 'nx.json');
    if (!fs.existsSync(nxJsonPath)) return {};
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const raw = fs.readFileSync(nxJsonPath, 'utf8');
        const parsed = JSON.parse(raw) as RawNxJson;
        return parsed.targetDefaults ?? {};
        // webpieces-disable catch-error-pattern -- malformed nx.json fails open so the check does not crash the build
    } catch (err: unknown) {
        //const error = toError(err); -- malformed nx.json fails open
        void err;
        return {};
    }
}

function findCompileExecutorsInUse(
    projectsConfig: ProjectsConfigurations,
    compileExecutors: string[],
): Set<string> {
    const known = new Set(compileExecutors);
    const inUse = new Set<string>();
    for (const cfg of Object.values(projectsConfig.projects)) {
        const targets = cfg.targets ?? {};
        for (const target of Object.values(targets)) {
            const executorName = target.executor;
            if (executorName && known.has(executorName)) {
                inUse.add(executorName);
            }
        }
    }
    return inUse;
}

function findProblems(
    relevantExecutors: string[],
    targetDefaults: Record<string, TargetDefaultEntry>,
    requiredDeps: string[],
): WiringProblem[] {
    const problems: WiringProblem[] = [];
    for (const executorName of relevantExecutors) {
        const entry = targetDefaults[executorName];
        const dependsOn = entry?.dependsOn ?? [];
        const missing = requiredDeps.filter((dep: string) => !dependsOn.includes(dep));
        if (missing.length > 0) {
            problems.push(new WiringProblem(executorName, missing, dependsOn));
        }
    }
    return problems;
}

/**
 * Normalize an nx dependsOn entry to a comparable string. The string form ("^build",
 * "validate-complete") passes through; the object form is rendered the same way
 * ({target:"build", dependencies:true} → "^build", {target:"build"} → "build").
 */
function normalizeDeps(deps: (string | TargetDependencyConfig)[]): string[] {
    return deps.map((dep) => {
        if (typeof dep === 'string') return dep;
        const target = dep.target ?? '';
        return dep.dependencies ? `^${target}` : target;
    });
}

/**
 * Check each compile project's RESOLVED build.dependsOn (targetDefaults already merged in)
 * for the required gates + `^build`. A project that overrode them away is flagged.
 */
function findProjectGateProblems(
    projectsConfig: ProjectsConfigurations,
    compileExecutors: Set<string>,
    requiredPerProject: string[],
): ProjectGateProblem[] {
    const problems: ProjectGateProblem[] = [];
    for (const [name, cfg] of Object.entries(projectsConfig.projects)) {
        // Tooling/foundation packages (type:tooling) BUILD the validators, so gating their own
        // build on validate-complete would create a bootstrap cycle. They are exempt: they keep
        // build-order ("^build") only. Application/library code is still fully gated.
        if ((cfg.tags ?? []).includes('type:tooling')) continue;
        const build = cfg.targets?.['build'];
        if (!build || !build.executor || !compileExecutors.has(build.executor)) continue;
        const dependsOn = normalizeDeps(build.dependsOn ?? []);
        const missing = requiredPerProject.filter((dep) => !dependsOn.includes(dep));
        if (missing.length > 0) {
            problems.push(new ProjectGateProblem(name, build.executor, missing, dependsOn));
        }
    }
    return problems;
}

function reportFailure(problems: WiringProblem[], requiredDeps: string[]): void {
    console.error('\n❌ webpieces validators are not wired into your build (nx.json).\n');
    console.error('The validators exist but no build depends on them, so they never run.');
    console.error('Add the missing dependsOn entries to nx.json targetDefaults:\n');
    const depsList = requiredDeps.map((dep: string) => `"${dep}"`).join(', ');
    for (const problem of problems) {
        const missingList = problem.missing.map((dep: string) => `"${dep}"`).join(', ');
        console.error(`  "${problem.executorName}": {`);
        console.error(`      "dependsOn": [${depsList}, "^build"]`);
        console.error('  }');
        console.error(`    missing: ${missingList}\n`);
    }
    console.error('To turn this wiring check off, set rules["nx-wiring"].mode="OFF" in');
    console.error('webpieces.config.json.\n');
}

function reportProjectGateFailure(problems: ProjectGateProblem[]): void {
    console.error('\n❌ Some projects override away the build gates in their project.json.\n');
    console.error('A project-level build.dependsOn OVERRIDES nx.json targetDefaults (nx does not');
    console.error('merge dependsOn). That silently drops "^build" (upstreams not built first →');
    console.error('builds against an empty dist) and/or the validators (build stays green while');
    console.error('validating nothing).\n');
    console.error('Fix: remove build.dependsOn from these project.json files so targetDefaults');
    console.error('apply, OR include all required entries explicitly:\n');
    for (const p of problems) {
        const missingList = p.missing.map((dep) => `"${dep}"`).join(', ');
        console.error(`  ${p.project} (${p.executorName}):`);
        console.error(`    resolved build.dependsOn: ${JSON.stringify(p.found)}`);
        console.error(`    missing: ${missingList}\n`);
    }
}

export default async function runExecutor(
    options: ValidateNxWiringOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    const shared = loadConfig(context.root);
    const rule = shared.rules.get('nx-wiring');
    if (rule && rule.isOff) {
        console.log('\n⏭️  Skipping validate-nx-wiring (mode: OFF)\n');
        return { success: true };
    }

    const requiredDeps = options.requiredDeps ?? DEFAULT_REQUIRED_DEPS;
    const compileExecutors = options.compileExecutors ?? DEFAULT_COMPILE_EXECUTORS;

    console.log('\n🔌 Validating webpieces validators are wired into the build\n');

    const projectGraph = await createProjectGraphAsync();
    const projectsConfig = readProjectsConfigurationFromProjectGraph(projectGraph);

    const inUse = findCompileExecutorsInUse(projectsConfig, compileExecutors);
    const relevantExecutors = compileExecutors.filter((executorName: string) =>
        inUse.has(executorName),
    );

    if (relevantExecutors.length === 0) {
        console.log('✅ No known compile executors in use — nothing to gate\n');
        return { success: true };
    }

    const targetDefaults = readTargetDefaults(context.root);
    const wiringProblems = findProblems(relevantExecutors, targetDefaults, requiredDeps);
    const gateProblems = findProjectGateProblems(projectsConfig, inUse, [
        ...requiredDeps,
        BUILD_ORDER_DEP,
    ]);

    if (wiringProblems.length === 0 && gateProblems.length === 0) {
        console.log('✅ Validators are wired into the build (targetDefaults + every project)\n');
        return { success: true };
    }

    if (wiringProblems.length > 0) reportFailure(wiringProblems, requiredDeps);
    if (gateProblems.length > 0) reportProjectGateFailure(gateProblems);
    return { success: false };
}
