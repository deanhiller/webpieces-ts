/**
 * WHERE an api library's generated documents and MCP tool catalogs live, read from the library's own
 * nx declarations — the ONE lookup both ends use:
 *
 * - the `openapi-generate` executor (`@webpieces/nx-webpieces-rules`) uses it to decide where to WRITE;
 * - `McpToolCatalog.fromPackages` (`@webpieces/mcp-server`) uses it to decide where to READ when the
 *   package it resolved is a workspace SOURCE directory (a pnpm link onto `libraries/...`) rather than
 *   a built one.
 *
 * The answer is the `outputPath` of the target `openapi-generate` dependsOn — the api library's
 * `build` (its @nx/js:tsc step), which writes the directory the package is packed from. It is never a hardcoded target
 * name and never an assumed `dist/`: webpieces-ts builds into a workspace-root `dist/apps/...` while
 * other repos build into a project-local `<project>/dist`, and either assumption is wrong in the other.
 *
 * Pure and browser-safe on purpose: it reads only the target map it is handed. The caller owns the
 * filesystem and its own error type, which is why a refusal is RETURNED rather than thrown.
 */

/** nx's object spelling of a `dependsOn` entry. */
export type LayoutDependsOnObject = {
    readonly target?: string;
    readonly projects?: string | readonly string[];
    readonly dependencies?: boolean;
};

/** One `dependsOn` entry, in either of nx's two spellings. */
export type LayoutDependsOn = string | LayoutDependsOnObject;

/** The one option this lookup reads off the target `openapi-generate` dependsOn. */
type OutputPathOptions = { readonly outputPath?: string };

/** One target, as project.json or nx describes it — only the two fields this lookup reads. */
export type LayoutTarget = {
    readonly dependsOn?: readonly LayoutDependsOn[];
    readonly options?: object;
};

/** The project's targets by name, as project.json or nx describes them. */
export type LayoutTargets = { readonly [targetName: string]: LayoutTarget | undefined };

/** The target `openapi-generate` writes into, and its outputPath. Data-only. */
export class GenerateOutputTarget {
    constructor(
        readonly targetName: string,
        /** Workspace-relative, with nx's `{workspaceRoot}` / `{projectRoot}` / `{projectName}` resolved. */
        readonly outputPath: string,
    ) {}
}

/** Why the lookup failed, and the one edit that fixes it. Data-only. */
export class GenerateLayoutProblem {
    constructor(
        readonly problem: string,
        readonly cure: string,
    ) {}
}

/** The outcome: exactly one of the two is set. Data-only. */
export class GenerateOutputLookup {
    constructor(
        readonly found: GenerateOutputTarget | undefined,
        readonly problem: GenerateLayoutProblem | undefined,
    ) {}
}

export class GeneratedApiDocsLayout {
    /** The target the nx plugin infers on a project tagged `generate:openapi`. */
    static readonly OPENAPI_TARGET = 'openapi-generate';
    /** The target the nx plugin infers on a project tagged `generate:docs-site`. */
    static readonly DOCS_TARGET = 'docs-generate';

    constructor(
        /** Workspace-relative project root, e.g. `libraries/apis/internal/lang-apis`. */
        readonly projectRoot: string,
        readonly projectName: string,
        readonly targets: LayoutTargets,
    ) {}

    /** The target `openapi-generate` dependsOn, and that target's outputPath. */
    outputTarget(): GenerateOutputLookup {
        const where = `${this.projectRoot}/project.json`;
        const generate = this.targets[GeneratedApiDocsLayout.OPENAPI_TARGET];
        if (generate === undefined) {
            return this.refuse(
                `${this.projectName} has no ${GeneratedApiDocsLayout.OPENAPI_TARGET} target.`,
                `Tag the project "generate:openapi" in ${where} and state targets.` +
                    `${GeneratedApiDocsLayout.OPENAPI_TARGET} (its dependsOn and options) there.`,
            );
        }
        const siblings = (generate.dependsOn ?? [])
            .map((entry: LayoutDependsOn) => this.siblingName(entry))
            .filter((name: string | undefined): name is string => name !== undefined);
        if (siblings.length !== 1) {
            return this.refuse(
                `${this.projectName}:${GeneratedApiDocsLayout.OPENAPI_TARGET} must dependsOn exactly ONE ` +
                    `target of its own project — the build step whose outputPath it writes into — and it ` +
                    `names ${siblings.length === 0 ? 'none' : siblings.join(', ')}.`,
                `Set "dependsOn": ["build"] on targets.${GeneratedApiDocsLayout.OPENAPI_TARGET} in ${where}, ` +
                    `where "build" is the @nx/js:tsc target (dependents pull generation in with ` +
                    `"^${GeneratedApiDocsLayout.OPENAPI_TARGET}" in nx.json targetDefaults).`,
            );
        }
        const targetName = siblings[0]!;
        const declared = (this.targets[targetName]?.options as OutputPathOptions | undefined)
            ?.outputPath;
        if (typeof declared !== 'string' || declared.trim() === '') {
            return this.refuse(
                `${this.projectName}:${targetName} — the target ${GeneratedApiDocsLayout.OPENAPI_TARGET} ` +
                    `dependsOn — declares no options.outputPath, so there is no build output to write the ` +
                    `documents into.`,
                `Declare targets.${targetName}.options.outputPath in ${where}.`,
            );
        }
        return new GenerateOutputLookup(new GenerateOutputTarget(targetName, this.interpolate(declared)), undefined);
    }

    /** nx's own tokens, so a path written the way nx accepts it resolves the way nx resolves it. */
    interpolate(text: string): string {
        return text
            .replace(/\{workspaceRoot\}\/?/g, '')
            .replace(/\{projectRoot\}/g, this.projectRoot)
            .replace(/\{projectName\}/g, this.projectName);
    }

    private siblingName(entry: LayoutDependsOn): string | undefined {
        if (typeof entry === 'string') return entry.startsWith('^') ? undefined : entry;
        const projects = entry.projects;
        const self =
            projects === undefined ||
            projects === 'self' ||
            (Array.isArray(projects) && projects.length === 1 && projects[0] === this.projectName);
        return entry.target !== undefined && entry.dependencies !== true && self ? entry.target : undefined;
    }

    private refuse(problem: string, cure: string): GenerateOutputLookup {
        return new GenerateOutputLookup(undefined, new GenerateLayoutProblem(problem, cure));
    }
}
