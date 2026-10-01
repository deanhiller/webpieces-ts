/**
 * `framework-tsconfig` (#1064, D7) — the COMPILER enforces the runtime a library's `framework:` tags
 * promise.
 *
 * A tag used to be a promise only the dependency graph checked: nothing stopped a `browser+node`
 * library from importing `fs` or reading `window`. The cure is not a lint rule that greps for `window`;
 * it is the compiler, which already refuses a global its `lib` / `types` do not declare. So this rule
 * checks the one file that decides what compiles — the library's `tsconfig.lib.json`, with everything
 * it `extends` — against its tags:
 *
 * | tags                                    | `lib`               | `types`        | effect                                       |
 * |-----------------------------------------|---------------------|----------------|----------------------------------------------|
 * | browser only (browser / angular / react) | includes `dom`     | no `node`      | `fs`, `process`, `__dirname`, `Buffer` fail  |
 * | node only (node / express)              | no `dom`            | includes `node`| `window`, `document`, `localStorage` fail    |
 * | anything else — universal (browser + node + react-native), browser + react-native, react-native | no `dom` | no `node` | pure TypeScript |
 *
 * An unset `lib` resolves to TypeScript's default for the target, which INCLUDES `dom`; an unset
 * `types` loads every installed `@types/*`, which includes `node`. So a library whose runtime excludes
 * either must STATE both. Only `tsconfig.lib.json` is read — an app's own tsconfig (react-native types,
 * a server's) is the app's business.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { FrameworkTsconfigConfig, matchesAnyGlob, Option, RuleFailError, RULE_NAMES } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { CodeValidator, ExecutorResult } from './code-validator';
import { ProjectScanTargets, ScannedProject } from './project-scan-targets';

const LIB_TSCONFIG = 'tsconfig.lib.json';

/** Envs whose every global is a browser's. */
const DOM_ENVS: readonly string[] = ['browser', 'angular', 'react'];
/** Envs whose every global is node's. */
const NODE_ENVS: readonly string[] = ['node', 'express'];

/** What a library's tsconfig must resolve to, given its framework set. Data-only. */
export class RuntimeCompilerOptions {
    constructor(
        /** `browser-only` | `node-only` | `pure` — which row of the table governs. */
        readonly row: string,
        readonly wantsDom: boolean,
        readonly wantsNodeTypes: boolean,
        /** The `compilerOptions` to paste. */
        readonly snippet: string,
    ) {}

    // webpieces-disable no-function-outside-class -- static factory of this class
    static forFrameworks(frameworks: readonly string[]): RuntimeCompilerOptions {
        if (frameworks.every((env: string) => DOM_ENVS.includes(env))) {
            return new RuntimeCompilerOptions('browser-only', true, false, '"lib": ["es2022", "dom"], "types": []');
        }
        if (frameworks.every((env: string) => NODE_ENVS.includes(env))) {
            return new RuntimeCompilerOptions('node-only', false, true, '"lib": ["es2022"], "types": ["node"]');
        }
        return new RuntimeCompilerOptions('pure', false, false, '"lib": ["es2022"], "types": []');
    }
}

/** ONE library whose tsconfig lets code compile that its runtime cannot run. Data-only. */
export class TsconfigRuntimeViolation {
    constructor(
        readonly project: string,
        /** Repo-relative path of the tsconfig.lib.json. */
        readonly tsconfig: string,
        readonly frameworks: readonly string[],
        readonly problems: readonly string[],
        readonly snippet: string,
    ) {}
}

/** The audit itself — no config, no git: a list of projects in, violations out. */
export class FrameworkTsconfigAudit {
    audit(workspaceRoot: string, projects: readonly ScannedProject[]): TsconfigRuntimeViolation[] {
        const out: TsconfigRuntimeViolation[] = [];
        for (const project of projects) {
            if (project.frameworks.length === 0) continue; // framework-tag's job
            const rel = `${project.dir}/${LIB_TSCONFIG}`;
            const abs = path.join(workspaceRoot, rel);
            if (!fs.existsSync(abs)) continue; // not a library
            const want = RuntimeCompilerOptions.forFrameworks(project.frameworks);
            const options = this.resolvedOptions(abs);
            const libs = options.lib?.map((each: string) => each.replace(/^lib\./, '').replace(/\.d\.ts$/, '').toLowerCase());
            const hasDom = libs === undefined || libs.some((lib: string) => lib === 'dom' || lib.startsWith('dom.'));
            const hasNode = options.types === undefined || options.types.includes('node');
            const problems: string[] = [];
            if (want.wantsDom && !hasDom) problems.push('`lib` does not include "dom", so the browser globals its runtime has do not compile');
            if (!want.wantsDom && hasDom) {
                problems.push(
                    libs === undefined
                        ? '`lib` is unset, so TypeScript\'s default — which includes "dom" — lets `window`/`document` compile'
                        : '`lib` includes "dom", so `window`/`document`/`localStorage` compile where the runtime has none',
                );
            }
            if (want.wantsNodeTypes && !hasNode) problems.push('`types` does not include "node", so node\'s globals do not compile');
            if (!want.wantsNodeTypes && hasNode) {
                problems.push(
                    options.types === undefined
                        ? '`types` is unset, so every installed @types/* — @types/node included — lets `fs`/`process`/`Buffer` compile'
                        : '`types` includes "node", so `fs`/`process`/`__dirname`/`Buffer` compile where the runtime has none',
                );
            }
            if (problems.length > 0) out.push(new TsconfigRuntimeViolation(project.name, rel, project.frameworks, problems, want.snippet));
        }
        return out;
    }

    /** The compilerOptions the file resolves to, `extends` chain included. */
    private resolvedOptions(abs: string): ts.CompilerOptions {
        const host = Object.assign({}, ts.sys, { onUnRecoverableConfigFileDiagnostic: (): void => undefined }) as ts.ParseConfigFileHost;
        return ts.getParsedCommandLineOfConfigFile(abs, {}, host)?.options ?? {};
    }
}

/** The one structured failure for every violation, shared by the validator and its spec. */
// webpieces-disable no-function-outside-class -- one structured rule failure shared by tests and runner
export function frameworkTsconfigError(violations: readonly TsconfigRuntimeViolation[]): RuleFailError {
    const details = violations
        .map((v: TsconfigRuntimeViolation) =>
            `  ${v.tsconfig} — ${v.project} [${v.frameworks.join(', ')}]\n` +
            v.problems.map((p: string) => `      ${p}`).join('\n') +
            `\n      set compilerOptions: { ${v.snippet} }`)
        .join('\n');
    return new RuleFailError(
        RULE_NAMES.FRAMEWORK_TSCONFIG,
        'A library\'s tsconfig.lib.json lets code compile that the runtime its framework tags promise cannot run.\n' + details,
        undefined,
        undefined,
        [
            new Option('Set each listed tsconfig.lib.json\'s compilerOptions.lib and compilerOptions.types to the values printed beside it, then fix whatever stops compiling — that code was never runnable everywhere the tags promised.', true),
            new Option('If the code genuinely needs the other runtime, the TAGS are wrong: narrow the framework tags (and move the library to the folder for that runtime).'),
        ],
    );
}

@injectable(bindingScopeValues.Singleton)
export class FrameworkTsconfigValidator extends CodeValidator<FrameworkTsconfigConfig> {
    constructor(
        config: FrameworkTsconfigConfig,
        private readonly targets: ProjectScanTargets,
    ) {
        super(config, RULE_NAMES.FRAMEWORK_TSCONFIG, RULE_NAMES.FRAMEWORK_TSCONFIG);
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        const mode = this.config.mode ?? 'OFF';
        if (mode === 'OFF') return { success: true };
        const allowed = this.config.allowedPaths ?? [];
        const projects = this.targets
            .projects(workspaceRoot, mode, RULE_NAMES.FRAMEWORK_TSCONFIG)
            .filter((p: ScannedProject) => !matchesAnyGlob(p.dir, allowed));
        const violations = new FrameworkTsconfigAudit().audit(workspaceRoot, projects);
        if (violations.length === 0) return { success: true };
        throw frameworkTsconfigError(violations);
    }
}
