import * as fs from 'fs';
import * as path from 'path';
import {
    GeneratedApiDocsLayout,
    LayoutTargets,
    McpToolCatalogError,
    McpToolCatalogFile,
    McpToolDefinition,
} from '@webpieces/core-util';

/** How every catalog failure is fixed: build the api library, whose `openapi-generate` writes them. */
const BUILD_IT =
    'Generate the api library\'s documents (`nx run <api-lib>:openapi-generate`, which builds it first) — ' +
    'or, for a spec that boots the MCP server, give nx.json\'s targetDefaults for `test` ' +
    '`"dependsOn": ["^openapi-generate"]` so every dependent generates it first.';

/** The two fields of an nx `project.json` this loader reads. */
type ProjectJson = { readonly name?: string; readonly targets?: LayoutTargets };

/**
 * ONE contract's MCP tools as a server boots them: the generated `mcp-<ContractClass>-tools.json`, and
 * the directory it was read from, so a boot refusal can name every directory it searched.
 *
 * `WpMcpServer` is handed a LIST of these (`McpBindOptions.toolCatalogs`), and `McpToolRegistry` checks
 * each `McpApiBinding` against the catalog of exactly its own contract (#1021).
 *
 * Build them with {@link McpToolCatalog.fromPackages}, the one call that works in every environment a
 * server runs in. The constructor is for a spec that hands the server catalogs it built in memory.
 */
export class McpToolCatalog {
    constructor(
        readonly file: McpToolCatalogFile,
        /** Where it was read from — an absolute directory, or a label for a catalog built in memory. */
        readonly directory: string,
    ) {}

    get contractName(): string {
        return this.file.contractName;
    }

    find(name: string): McpToolDefinition | undefined {
        return this.file.find(name);
    }

    names(): readonly string[] {
        return this.file.names();
    }

    /**
     * Every MCP tool catalog the named api-library packages carry — ONE call, in every environment:
     *
     * ```typescript
     * McpToolCatalog.fromPackages(['@myorg/lang-website-apis'], __dirname)
     * ```
     *
     * Each package is found the way node's own resolution finds it: `node_modules/<pkg>` in
     * `resolveFrom` and every directory above it, symlinks followed. What that directory holds decides
     * where the files are:
     *
     * - `mcp-*-tools.json` beside its `package.json` → a BUILT or PUBLISHED package (a Docker image that
     *   relinks `node_modules/@myorg/*` onto `dist/libraries/**`, or an npm consumer) → read them there;
     * - a `project.json` → a workspace SOURCE directory (pnpm links `node_modules/@myorg/x` onto
     *   `libraries/.../x` for local dev and vitest) → read the `outputPath` of the target its
     *   `openapi-generate` dependsOn, resolved against the nx workspace root (found by walking up to
     *   `nx.json`), and read the files there. That is the SAME lookup the executor used to decide where
     *   to write them (`GeneratedApiDocsLayout`).
     *
     * @param resolveFrom where node resolution starts — pass `__dirname` of the calling file. It is
     *   required because the right answer is the CALLER's `node_modules`: in a pnpm workspace the api
     *   library is linked into the server project's own `node_modules`, which neither the process's cwd
     *   nor this package's install location can see.
     */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static fromPackages(packages: readonly string[], resolveFrom: string): McpToolCatalog[] {
        if (packages.length === 0) {
            throw new McpToolCatalogError(
                'McpToolCatalog.fromPackages was given no packages.',
                "Name every api library whose contracts this server binds, e.g. fromPackages(['@myorg/my-apis'], __dirname).",
            );
        }
        const loader = new McpPackageCatalogs(resolveFrom);
        return packages.flatMap((packageName: string) => loader.load(packageName));
    }
}

/** The filesystem half of {@link McpToolCatalog.fromPackages}: resolve, classify, read. */
class McpPackageCatalogs {
    constructor(private readonly resolveFrom: string) {}

    load(packageName: string): McpToolCatalog[] {
        const packageDir = this.resolve(packageName);
        if (this.catalogFiles(packageDir).length > 0) {
            return this.read(packageName, packageDir, packageDir);
        }
        if (fs.existsSync(path.join(packageDir, 'project.json'))) {
            return this.read(packageName, packageDir, this.outputDirOfSource(packageName, packageDir));
        }
        throw new McpToolCatalogError(
            `${packageName} resolved to ${packageDir}, which holds neither an mcp-<ContractClass>-tools.json ` +
                '(a built package) nor a project.json (a workspace source directory).',
            BUILD_IT,
        );
    }

    /** `<dir>/node_modules/<pkg>/package.json` in `resolveFrom` and every parent — node's own walk. */
    private resolve(packageName: string): string {
        const searched: string[] = [];
        let dir = path.resolve(this.resolveFrom);
        for (;;) {
            const candidate = path.join(dir, 'node_modules', ...packageName.split('/'));
            searched.push(candidate);
            if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        throw new McpToolCatalogError(
            `${packageName} is not installed where the MCP server can see it. Searched:\n` +
                searched.map((each: string) => `  ${each}`).join('\n'),
            `Add ${packageName} as a dependency of the server project, and pass the calling file's ` +
                '__dirname as fromPackages(...)\'s resolveFrom.',
        );
    }

    /**
     * A workspace SOURCE directory: the outputPath of the target its `openapi-generate` dependsOn,
     * against the workspace root — never an assumed `dist/`.
     */
    private outputDirOfSource(packageName: string, packageDir: string): string {
        const workspaceRoot = this.workspaceRootAbove(packageName, packageDir);
        const project = JSON.parse(fs.readFileSync(path.join(packageDir, 'project.json'), 'utf8')) as ProjectJson;
        const projectRoot = path.relative(workspaceRoot, packageDir).split(path.sep).join('/');
        const lookup = new GeneratedApiDocsLayout(projectRoot, project.name ?? projectRoot, project.targets ?? {})
            .outputTarget();
        if (lookup.found === undefined) {
            throw new McpToolCatalogError(
                `${packageName} is the workspace source directory ${packageDir}, and its generated MCP tool ` +
                    `catalogs cannot be located: ${lookup.problem!.problem}`,
                lookup.problem!.cure,
            );
        }
        return path.resolve(workspaceRoot, lookup.found.outputPath);
    }

    private workspaceRootAbove(packageName: string, packageDir: string): string {
        let dir = packageDir;
        for (;;) {
            if (fs.existsSync(path.join(dir, 'nx.json'))) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        throw new McpToolCatalogError(
            `${packageName} resolved to ${packageDir}, which has a project.json but no nx.json above it, ` +
                'so there is no nx workspace to resolve its build outputPath against.',
            'Link the BUILT package instead (its directory holds the mcp-<ContractClass>-tools.json files).',
        );
    }

    private read(packageName: string, packageDir: string, dir: string): McpToolCatalog[] {
        const files = this.catalogFiles(dir);
        if (files.length === 0) {
            throw new McpToolCatalogError(
                `${packageName} (${packageDir}) has no mcp-<ContractClass>-tools.json in ${dir}` +
                    (fs.existsSync(dir) ? '.' : ' — the directory does not exist, so the library was never built.'),
                BUILD_IT,
            );
        }
        return files.map(
            (file: string) =>
                new McpToolCatalog(
                    McpToolCatalogFile.fromJsonText(file, fs.readFileSync(path.join(dir, file), 'utf8')),
                    dir,
                ),
        );
    }

    private catalogFiles(dir: string): string[] {
        if (!fs.existsSync(dir)) return [];
        return fs
            .readdirSync(dir)
            .filter((file: string) => McpToolCatalogFile.contractNameOf(file) !== undefined)
            .sort();
    }
}
