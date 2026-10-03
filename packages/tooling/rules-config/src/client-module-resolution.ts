import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { InformAiError } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';

class DependencyPackageIdentity {
    name?: string;
}

/** Resolve a selected module through the client's declared installation graph, including pnpm bundles. */
export class ClientModuleResolution {
    constructor(private readonly clientRoot: string) {}

    resolve(moduleName: string): string {
        const direct = this.tryResolve(
            createRequire(path.join(this.clientRoot, 'package.json')),
            moduleName,
        );
        if (direct !== null) return direct;
        if (moduleName.startsWith('.') || path.isAbsolute(moduleName)) {
            throw new InformAiError(
                `Cannot resolve declared local rule-pack module ${moduleName} from ${this.clientRoot}; repair the module declarations to point to its existing public module.`,
            );
        }
        const candidates = this.fromDeclaredDependencies(moduleName);
        if (candidates.length !== 1) {
            const cause =
                candidates.length === 0
                    ? 'is not installed through a declared client dependency'
                    : 'resolves to multiple installed versions';
            throw new InformAiError(
                `Declared rule-pack module ${moduleName} ${cause}. Pin and install one version of its package or tooling bundle in package.json, then run pnpm install.`,
            );
        }
        return candidates[0];
    }

    private fromDeclaredDependencies(moduleName: string): string[] {
        const pending = [path.join(this.clientRoot, 'package.json')],
            visited = new Set<string>(),
            candidates = new Set<string>();
        while (pending.length > 0) {
            const manifestPath = pending.shift()!;
            if (visited.has(manifestPath)) continue;
            visited.add(manifestPath);
            const requireHere = createRequire(manifestPath);
            if (path.dirname(manifestPath) !== this.clientRoot) {
                const found = this.tryResolve(requireHere, moduleName);
                if (found !== null) candidates.add(fs.realpathSync(found));
            }
            // webpieces-disable no-any-unknown -- only declared dependency key names are consumed from package JSON.
            const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<
                string,
                // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
                unknown
            >;
            for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
                const dependencies = pkg[section];
                if (
                    !dependencies ||
                    typeof dependencies !== 'object' ||
                    Array.isArray(dependencies)
                )
                    continue;
                for (const name of Object.keys(dependencies)) {
                    const dependencyManifest = this.dependencyManifest(requireHere, name);
                    if (dependencyManifest !== null) pending.push(dependencyManifest);
                }
            }
        }
        return [...candidates];
    }

    private dependencyManifest(requireHere: NodeRequire, name: string): string | null {
        const manifest = this.tryResolve(requireHere, `${name}/package.json`);
        if (manifest !== null) return fs.realpathSync(manifest);
        const entry = this.tryResolve(requireHere, name);
        if (entry === null) return null;
        let directory = path.dirname(entry);
        while (true) {
            const candidate = path.join(directory, 'package.json');
            if (fs.existsSync(candidate)) {
                const pkg = JSON.parse(
                    fs.readFileSync(candidate, 'utf8'),
                ) as DependencyPackageIdentity;
                if (pkg.name === name) return fs.realpathSync(candidate);
            }
            const parent = path.dirname(directory);
            if (parent === directory) return null;
            directory = parent;
        }
    }

    private tryResolve(requireHere: NodeRequire, name: string): string | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- resolution probes enumerate declared dependency roots, never infer selected packs.
        try {
            return requireHere.resolve(name);
        // webpieces-disable no-any-unknown -- external JSON or runtime exports are validated before policy execution
        } catch (err: unknown) {
            const error = toError(err);
            if (
                'code' in error &&
                ['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(String(error.code))
            )
                return null;
            throw error;
        }
    }
}
