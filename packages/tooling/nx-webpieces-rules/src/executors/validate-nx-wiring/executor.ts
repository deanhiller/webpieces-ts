/**
 * Validate Nx Wiring Executor
 *
 * Enforces that the webpieces validators are actually wired into the build in
 * nx.json. The plugin auto-infers the validator targets (architecture:validate-complete,
 * per-project validate-no-file-import-cycles), but the load-bearing connection that
 * makes a build DEPEND on them lives in each repo's hand-edited nx.json:
 *
 *   "@nx/js:tsc": {
 *       "dependsOn": ["architecture:validate-complete", "validate-no-file-import-cycles", "^build"]
 *   }
 *
 * If that dependsOn is stripped, the validators exist but never run and a build stays
 * green while validating nothing. This executor fails when the wiring is missing.
 *
 * Conservative by design: it only REQUIRES wiring on compile executors that are
 * actually used somewhere in the project graph (@nx/js:tsc, @angular/build:application).
 * A repo that uses neither has nothing to gate and passes.
 *
 * Disable per validator in webpieces.config.json (rules[name].mode="OFF"), but the
 * wiring itself is governed by the "nx-wiring" rule (default on) so the build gate stays.
 *
 * Usage: nx run architecture:validate-nx-wiring
 */

import type { ExecutorContext } from '@nx/devkit';
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

async function findCompileExecutorsInUse(compileExecutors: string[]): Promise<Set<string>> {
    const projectGraph = await createProjectGraphAsync();
    const projectsConfig = readProjectsConfigurationFromProjectGraph(projectGraph);
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

function reportFailure(problems: WiringProblem[], requiredDeps: string[]): void {
    console.error('\n❌ webpieces validators are not wired into your build.\n');
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
    console.error('To disable an INDIVIDUAL validator, set rules[name].mode="OFF" in');
    console.error('webpieces.config.json — but the wiring above must stay installed so the');
    console.error('build gate keeps working. To turn this wiring check itself off, set');
    console.error('rules["nx-wiring"].mode="OFF" in webpieces.config.json.\n');
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

    const inUse = await findCompileExecutorsInUse(compileExecutors);
    const relevantExecutors = compileExecutors.filter((executorName: string) =>
        inUse.has(executorName),
    );

    if (relevantExecutors.length === 0) {
        console.log('✅ No known compile executors in use — nothing to gate\n');
        return { success: true };
    }

    const targetDefaults = readTargetDefaults(context.root);
    const problems = findProblems(relevantExecutors, targetDefaults, requiredDeps);

    if (problems.length === 0) {
        console.log('✅ Validators are wired into the build\n');
        return { success: true };
    }

    reportFailure(problems, requiredDeps);
    return { success: false };
}
