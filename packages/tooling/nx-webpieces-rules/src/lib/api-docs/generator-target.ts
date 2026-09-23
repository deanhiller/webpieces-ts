/**
 * The shared half of the `openapi-generate` and `docs-generate` executors: WHERE a generated document
 * goes, and the proof that the target is wired so that nx both orders and caches it correctly.
 *
 * Both halves read the project's own declarations and never supply a value of their own:
 *
 * - the documents' directory is the `outputPath` of the target `openapi-generate` dependsOn — the api
 *   library's `compile` (tsc) step, which writes the directory the package is packed from, so the
 *   documents ship INSIDE the published package. It is ASKED of nx through `GeneratedApiDocsLayout`
 *   (`@webpieces/core-util`), the same lookup `McpToolCatalog.fromPackages` reads with, and never
 *   assumed: this repo builds into a workspace-root `dist/apps/...`, another consumer builds into a
 *   project-local `<project>/dist`, and hardcoding either one — or the target's NAME — generates the
 *   document somewhere the package is not packed from;
 * - the ordering and the cache are the target's own `dependsOn` and `outputs`, which the executor
 *   checks rather than trusts, because both failures are silent: without the `dependsOn` edge, tsc's
 *   clean of `outputPath` races the write (the document vanishes and a dependent test dies on ENOENT,
 *   intermittently, only in CI), and `outputs` that miss a written file make every cache hit restore a
 *   package without that file.
 */

import type { ExecutorContext, TargetConfiguration, TargetDependencyConfig } from '@nx/devkit';
import { GeneratedApiDocsLayout } from '@webpieces/core-util';
import { Option, RuleFailError, matchesAnyGlob } from '@webpieces/rules-config';
import * as fs from 'fs';
import * as path from 'path';

/** What `dependsOn` may name: a sibling target by name, or nx's object form of the same. */
type DependsOnEntry = string | TargetDependencyConfig;

export class GeneratorTarget {
    constructor(
        /** The executor's name, which is what every refusal is reported under. */
        readonly ruleName: string,
        readonly workspaceRoot: string,
        readonly projectName: string,
        /** Workspace-relative. */
        readonly projectRoot: string,
        readonly targetName: string,
        readonly target: TargetConfiguration,
        readonly targets: Record<string, TargetConfiguration>,
    ) {}

    // webpieces-disable no-function-outside-class -- static factory of this class
    static of(ruleName: string, context: ExecutorContext): GeneratorTarget {
        const projectName = context.projectName ?? '';
        const project = context.projectsConfigurations?.projects[projectName];
        const targetName = context.targetName ?? '';
        const target = project?.targets?.[targetName];
        if (project === undefined || target === undefined) {
            // nx hands every executor its own project and target; their absence is our bug, not the consumer's.
            throw new Error(`${ruleName}: nx did not describe project '${projectName}' target '${targetName}'`);
        }
        return new GeneratorTarget(
            ruleName, context.root, projectName, project.root, targetName, target, project.targets ?? {});
    }

    /**
     * Absolute path to the directory the documents live in: the `outputPath` of the target
     * `openapi-generate` dependsOn — the directory the package is packed from.
     */
    documentsDir(): string {
        const lookup = new GeneratedApiDocsLayout(this.projectRoot, this.projectName, this.targets).outputTarget();
        if (lookup.found === undefined) {
            throw new RuleFailError(
                this.ruleName,
                `${lookup.problem!.problem} The documents go into the build's own output directory — the ` +
                    'one the package is packed from — and are never assumed to be ./dist.',
                undefined,
                undefined,
                [new Option(lookup.problem!.cure, true)],
            );
        }
        return path.resolve(this.workspaceRoot, lookup.found.outputPath);
    }

    /** Absolute `<projectRoot>/<dir>`, refusing anything that is not strictly inside the project. */
    insideProject(dir: string, optionName: string): string {
        const projectAbs = path.resolve(this.workspaceRoot, this.projectRoot);
        const resolved = path.resolve(projectAbs, dir);
        const relative = path.relative(projectAbs, resolved);
        if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) return resolved;
        throw new RuleFailError(
            this.ruleName,
            `${this.projectName}:${this.targetName} options.${optionName} is '${dir}', which is not a directory ` +
                `strictly inside ${this.projectRoot}. It is emptied and rewritten on every run, so it may only ` +
                'name a directory of the project\'s own.',
            undefined,
            undefined,
            [new Option(`Set options.${optionName} to a project-relative directory, e.g. "generated-docs"`, true)],
        );
    }

    /** Refuse unless this target `dependsOn` the sibling `required` target. */
    assertDependsOn(required: string): void {
        const entries: readonly DependsOnEntry[] = this.target.dependsOn ?? [];
        if (entries.some((entry: DependsOnEntry) => this.namesSibling(entry, required))) return;
        throw new RuleFailError(
            this.ruleName,
            `${this.projectName}:${this.targetName} does not declare dependsOn "${required}". It reads what ` +
                `${required} writes, so without that edge nx may run it before or alongside ${required} and ` +
                `render a stale or missing document. That fails intermittently and mostly in CI, which is ` +
                `why it is refused here instead.`,
            undefined,
            undefined,
            [new Option(`Add "dependsOn": ["${required}"] to the ${this.targetName} target in ${this.projectRoot}/project.json`, true)],
        );
    }

    /** Refuse unless every written file is covered by the target's declared `outputs`, so a cache hit restores it. */
    assertOutputsCover(writtenAbs: readonly string[]): void {
        const patterns = (this.target.outputs ?? []).map((output: string) => this.interpolate(output));
        const uncovered = writtenAbs
            .map((file: string) => path.relative(this.workspaceRoot, file).split(path.sep).join('/'))
            .filter((file: string) => !matchesAnyGlob(file, patterns));
        if (uncovered.length === 0) return;
        throw new RuleFailError(
            this.ruleName,
            `${this.projectName}:${this.targetName} wrote files its declared outputs do not cover, so a ` +
                `cache hit would restore a package WITHOUT them:\n` +
                uncovered.map((file: string) => `  ${file}`).join('\n'),
            undefined,
            undefined,
            [new Option(
                `Cover them in the ${this.targetName} target's "outputs" in ${this.projectRoot}/project.json, ` +
                    `e.g. "{workspaceRoot}/${path.posix.dirname(uncovered[0]!)}/<the files>"`,
                true,
            )],
        );
    }

    /** A workspace-relative path the consumer stated, from `options`, required and never defaulted. */
    requiredOption(value: string | undefined, name: string): string {
        if (typeof value === 'string' && value.trim() !== '') return value;
        throw new RuleFailError(
            this.ruleName,
            `${this.projectName}:${this.targetName} has no options.${name}. It is required and has no default.`,
            undefined,
            undefined,
            [new Option(`Set options.${name} on the ${this.targetName} target in ${this.projectRoot}/project.json`, true)],
        );
    }

    private namesSibling(entry: DependsOnEntry, required: string): boolean {
        if (typeof entry === 'string') return entry === required;
        const projects = entry.projects;
        const self = projects === undefined || projects === 'self' ||
            (Array.isArray(projects) && projects.length === 1 && projects[0] === this.projectName);
        return entry.target === required && entry.dependencies !== true && self;
    }

    /** nx's own tokens, so a path written the way nx accepts it resolves the way nx resolves it. */
    private interpolate(text: string): string {
        return text
            .replace(/\{workspaceRoot\}\/?/g, '')
            .replace(/\{projectRoot\}/g, this.projectRoot)
            .replace(/\{projectName\}/g, this.projectName)
            .replace(/\{options\.([A-Za-z0-9_]+)\}/g, (whole: string, key: string): string => {
                const value = this.target.options?.[key];
                return typeof value === 'string' ? value : whole;
            });
    }
}

/**
 * Generate into a STAGING directory, then publish into the output directory — so the executor knows
 * exactly which files the run produced (for {@link GeneratorTarget.assertOutputsCover}) without
 * parsing a generator's console output, and a failed run leaves the output directory untouched.
 */
export class StagedOutput {
    publish(stagingDir: string, destDir: string): string[] {
        const written: string[] = [];
        const copy = (from: string, to: string): void => {
            fs.mkdirSync(to, { recursive: true });
            for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
                const source = path.join(from, entry.name);
                const target = path.join(to, entry.name);
                if (entry.isDirectory()) {
                    copy(source, target);
                } else {
                    fs.copyFileSync(source, target);
                    written.push(target);
                }
            }
        };
        copy(stagingDir, destDir);
        return written.sort();
    }
}
