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
    /**
     * The target the nx plugin infers on a DTO library tagged `generate:openapi-components`: it writes
     * the library's components-only `components.openapi.json`, which contract documents `$ref` (#1058).
     */
    static readonly COMPONENTS_TARGET = 'openapi-components-generate';
    /** The target the nx plugin infers on a project tagged `generate:docs-site`. */
    static readonly DOCS_TARGET = 'docs-generate';
    /** The file a DTO library's components-only document is written to, beside its package.json. */
    static readonly COMPONENTS_FILE = 'components.openapi.json';

    /** The tag that opts a project into `generateTarget` — what a cure tells the reader to add. */
    // webpieces-disable no-function-outside-class -- static lookup on the class that owns the target names
    static tagOf(generateTarget: string): string {
        return generateTarget === GeneratedApiDocsLayout.COMPONENTS_TARGET
            ? 'generate:openapi-components'
            : 'generate:openapi';
    }

    constructor(
        /** Workspace-relative project root, e.g. `libraries/apis/internal/lang-apis`. */
        readonly projectRoot: string,
        readonly projectName: string,
        readonly targets: LayoutTargets,
    ) {}

    /**
     * The target `generateTarget` dependsOn, and that target's outputPath.
     *
     * @param generateTarget the generating target whose output directory is asked for —
     *   {@link OPENAPI_TARGET} for a contract library's documents and catalogs, {@link COMPONENTS_TARGET}
     *   for a DTO library's components document. Both write into the outputPath of the ONE sibling
     *   target they dependsOn.
     */
    outputTarget(generateTarget: string): GenerateOutputLookup {
        const where = `${this.projectRoot}/project.json`;
        const generate = this.targets[generateTarget];
        if (generate === undefined) {
            return this.refuse(
                `${this.projectName} has no ${generateTarget} target.`,
                `Tag the project "${GeneratedApiDocsLayout.tagOf(generateTarget)}" in ${where} and state targets.` +
                    `${generateTarget} (its dependsOn and options) there.`,
            );
        }
        const siblings = (generate.dependsOn ?? [])
            .map((entry: LayoutDependsOn) => this.siblingName(entry))
            .filter((name: string | undefined): name is string => name !== undefined);
        if (siblings.length !== 1) {
            return this.refuse(
                `${this.projectName}:${generateTarget} must dependsOn exactly ONE ` +
                    `target of its own project — the build step whose outputPath it writes into — and it ` +
                    `names ${siblings.length === 0 ? 'none' : siblings.join(', ')}.`,
                `Set "dependsOn": ["build"] on targets.${generateTarget} in ${where}, ` +
                    `where "build" is the @nx/js:tsc target (dependents pull generation in with ` +
                    `"^${generateTarget}" in nx.json targetDefaults).`,
            );
        }
        const targetName = siblings[0]!;
        const declared = (this.targets[targetName]?.options as OutputPathOptions | undefined)
            ?.outputPath;
        if (typeof declared !== 'string' || declared.trim() === '') {
            return this.refuse(
                `${this.projectName}:${targetName} — the target ${generateTarget} ` +
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
