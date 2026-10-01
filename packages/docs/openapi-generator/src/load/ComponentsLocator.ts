import * as fs from 'node:fs';
import * as path from 'node:path';
import { GeneratedApiDocsLayout, LayoutTargets } from '@webpieces/core-util';
import { OpenApiGenerationError } from '../OpenApiGenerationError';
import { ComponentsReference } from '../generate/SchemaPlacement';
import { MissingComponents, PublishedComponents } from '../generate/UpstreamComponents';

/** The two fields of an nx `project.json` this lookup reads. */
type ProjectJson = { readonly name?: string; readonly targets?: LayoutTargets };

/** The fields of a components document this lookup reads. */
type ComponentsDocumentJson = {
    // webpieces-disable no-any-unknown -- a file off disk: compared by value, never trusted as a string
    readonly 'x-webpieces-id'?: unknown;
    // webpieces-disable no-any-unknown -- only the schema NAMES are read; the schemas stay opaque
    readonly components?: { readonly schemas?: Record<string, unknown> };
};

/** The outcome of locating ONE package's components document: exactly one side is set. Data-only. */
export class LocatedComponents {
    constructor(
        readonly published: PublishedComponents | undefined,
        readonly missing: MissingComponents | undefined,
    ) {}
}

/**
 * Find the `components.openapi.json` a package publishes (#1058) — by the SAME package lookup
 * `McpToolCatalog.fromPackages` (`@webpieces/mcp-server`) uses to find a library's MCP catalogs:
 *
 * 1. resolve `<pkg>/package.json` the way node does, walking `node_modules` up from the manifest's
 *    directory (symlinks followed) — falling back to the directory the COMPILER read the type from
 *    (the nearest `package.json` above its declaration), for a workspace that maps packages with
 *    tsconfig `paths` and links none;
 * 2. that directory holds `components.openapi.json` → a BUILT or PUBLISHED package → read it there;
 * 3. it holds a `project.json` → a workspace SOURCE directory → read it from the `outputPath` of the
 *    target its `openapi-components-generate` dependsOn ({@link GeneratedApiDocsLayout}), resolved
 *    against the nx workspace root found by walking up to `nx.json`.
 *
 * Never an assumed `dist/`. Anything else is a {@link MissingComponents} carrying where it looked and
 * what it found — which the generator turns into the fail-closed refusal, so a missing document is
 * never a reason to copy a schema in.
 */
export class ComponentsLocator {
    /**
     * @param packageName the package whose document is wanted.
     * @param resolveFrom where node resolution starts — the manifest's directory.
     * @param declaredIn the directory of the `package.json` the compiler read the type from, if any.
     */
    locate(
        packageName: string,
        resolveFrom: string,
        declaredIn: string | undefined,
    ): LocatedComponents {
        const packageDir = this.resolve(packageName, resolveFrom) ?? declaredIn;
        if (packageDir === undefined) {
            return this.missing(
                packageName,
                `it is not installed where ${resolveFrom} can see it, and no package.json above its declaration names it`,
            );
        }
        const beside = path.join(packageDir, GeneratedApiDocsLayout.COMPONENTS_FILE);
        if (fs.existsSync(beside)) {
            return this.read(packageName, beside);
        }
        if (fs.existsSync(path.join(packageDir, 'project.json'))) {
            return this.fromSource(packageName, packageDir);
        }
        return this.missing(
            packageName,
            `${packageDir} holds neither a ${GeneratedApiDocsLayout.COMPONENTS_FILE} (a built package) nor ` +
                'a project.json (a workspace source directory)',
        );
    }

    /** `<dir>/node_modules/<pkg>/package.json` in `resolveFrom` and every parent — node's own walk. */
    private resolve(packageName: string, resolveFrom: string): string | undefined {
        let dir = path.resolve(resolveFrom);
        for (;;) {
            const candidate = path.join(dir, 'node_modules', ...packageName.split('/'));
            if (fs.existsSync(path.join(candidate, 'package.json'))) {
                return fs.realpathSync(candidate);
            }
            const parent = path.dirname(dir);
            if (parent === dir) {
                return undefined;
            }
            dir = parent;
        }
    }

    /** A workspace SOURCE directory: the outputPath of the target its components target dependsOn. */
    private fromSource(packageName: string, packageDir: string): LocatedComponents {
        const workspaceRoot = this.workspaceRootAbove(packageDir);
        if (workspaceRoot === undefined) {
            return this.missing(
                packageName,
                `${packageDir} has a project.json but no nx.json above it, so there is no build outputPath to read it from`,
            );
        }
        const project = JSON.parse(
            fs.readFileSync(path.join(packageDir, 'project.json'), 'utf8'),
        ) as ProjectJson;
        const projectRoot = path.relative(workspaceRoot, packageDir).split(path.sep).join('/');
        const lookup = new GeneratedApiDocsLayout(
            projectRoot,
            project.name ?? projectRoot,
            project.targets ?? {},
        ).outputTarget(GeneratedApiDocsLayout.COMPONENTS_TARGET);
        if (lookup.found === undefined) {
            return this.missing(packageName, lookup.problem!.problem);
        }
        const file = path.resolve(
            workspaceRoot,
            lookup.found.outputPath,
            GeneratedApiDocsLayout.COMPONENTS_FILE,
        );
        if (!fs.existsSync(file)) {
            return this.missing(
                packageName,
                `${file} does not exist — run \`nx run ${project.name ?? projectRoot}:` +
                    `${GeneratedApiDocsLayout.COMPONENTS_TARGET}\` (dependents reach it through ` +
                    `"^${GeneratedApiDocsLayout.COMPONENTS_TARGET}")`,
            );
        }
        return this.read(packageName, file);
    }

    private workspaceRootAbove(packageDir: string): string | undefined {
        let dir = packageDir;
        for (;;) {
            if (fs.existsSync(path.join(dir, 'nx.json'))) {
                return dir;
            }
            const parent = path.dirname(dir);
            if (parent === dir) {
                return undefined;
            }
            dir = parent;
        }
    }

    /**
     * Read one document. Its `x-webpieces-id` must be the package-qualified URI it is referenced by:
     * a document published under another package's name is a copy, and referencing it would point
     * every `$ref` at the wrong owner.
     */
    private read(packageName: string, file: string): LocatedComponents {
        const document = JSON.parse(fs.readFileSync(file, 'utf8')) as ComponentsDocumentJson;
        const expected = ComponentsReference.documentUri(packageName);
        if (document['x-webpieces-id'] !== expected) {
            throw new OpenApiGenerationError(
                `${file} is not ${packageName}'s components document: its x-webpieces-id is ` +
                    `${JSON.stringify(document['x-webpieces-id'])}, not "${expected}"`,
                file,
                `Regenerate ${packageName}'s components document; never copy one package's document into another.`,
            );
        }
        const schemas = Object.keys(document.components?.schemas ?? {});
        return new LocatedComponents(
            new PublishedComponents(packageName, file, new Set<string>(schemas)),
            undefined,
        );
    }

    private missing(packageName: string, reason: string): LocatedComponents {
        return new LocatedComponents(undefined, new MissingComponents(packageName, reason));
    }
}
