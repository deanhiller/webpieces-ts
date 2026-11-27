/**
 * Validate Versions Locked Executor
 *
 * Validates that package.json versions are:
 * 1. LOCKED (exact versions, no semver ranges like ^, ~, *)
 * 2. CONSISTENT across all package.json files (no version conflicts)
 *
 * Why locked versions matter:
 * - Micro bugs ARE introduced via patch versions (1.4.5 → 1.4.6)
 * - git bisect fails when software changes OUTSIDE of git
 * - Library upgrades must be explicit via PR/commit, not implicit drift
 *
 * Usage:
 * nx run architecture:validate-versions-locked
 */

import type { ExecutorContext } from '@nx/devkit';
import * as fs from 'fs';
import * as path from 'path';
import { RuleGate } from '../../lib/rule-gate';
import { DependencyWorkspace, DependencyOwner } from '../../lib/dependency-workspace';
import { DependencyVersion } from '../../lib/dependency-policies';

export interface ValidateVersionsLockedOptions {
    // No options needed
}

export interface ExecutorResult {
    success: boolean;
}

// webpieces-disable max-lines-new-methods -- Existing method from renamed validate-versions file
// Find all package.json files except node_modules, dist, .nx, .angular
export function findPackageJsonFiles(dir: string, basePath = ''): string[] {
    const files: string[] = [];
    const items = fs.readdirSync(dir);

    for (const item of items) {
        const fullPath = path.join(dir, item);
        const relativePath = path.join(basePath, item);

        // Skip these directories
        if (['node_modules', 'dist', '.nx', '.angular', 'tmp', '.git'].includes(item)) {
            continue;
        }

        // Skip platform-specific node_modules backups (node_modules_mac, node_modules_linux, etc.)
        if (item.startsWith('node_modules_')) {
            continue;
        }

        // Skip all hidden directories (starting with .)
        if (item.startsWith('.')) {
            continue;
        }

        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            // Don't descend into a nested git repository (e.g. a clone under repositories/): it is a
            // separate project with its own version policy, NOT part of this monorepo's version lock.
            // The presence of a `.git` entry (dir for a real clone, file for a worktree/submodule)
            // marks a repo boundary — the same signal the AI guards use to scope to the current repo.
            if (fs.existsSync(path.join(fullPath, '.git'))) {
                continue;
            }
            files.push(...findPackageJsonFiles(fullPath, relativePath));
        } else if (item === 'package.json') {
            files.push(fullPath);
        }
    }

    return files;
}

/** Resolve catalogue pins before comparing authored direct versions. Published peers remain ranges. */
class VersionsLockedExecutor {
    async run(
        _options: ValidateVersionsLockedOptions,
        context: ExecutorContext,
    ): Promise<ExecutorResult> {
        if (new RuleGate().isDisabled(context.root, 'validate-versions-locked', true))
            return { success: true };
        const workspace = new DependencyWorkspace(context.root);
        const owners = [new DependencyOwner('.', workspace.rootManifest), ...workspace.owners];
        const versions = new Map<string, string>();
        const errors: string[] = [];
        for (const owner of owners) {
            if (!owner.manifest) continue;
            for (const section of [
                'dependencies',
                'devDependencies',
                'optionalDependencies',
            ] as const) {
                for (const declaration of Object.entries(owner.manifest[section] ?? {})) {
                    const name = declaration[0];
                    const specifier = declaration[1];
                    if (specifier.startsWith('workspace:') || specifier.startsWith('file:'))
                        continue;
                    const catalog = specifier.slice('catalog:'.length);
                    const pin = specifier.startsWith('catalog:')
                        ? (catalog
                              ? workspace.catalog.catalogs?.[catalog]
                              : workspace.catalog.catalog)?.[name]
                        : specifier;
                    const where = `${owner.directory}/package.json ${section}.${name}`;
                    if (!pin || !new DependencyVersion().isExact(pin)) {
                        errors.push(
                            `${where}: ${specifier} must resolve to an exact locked version, found ${String(pin)}`,
                        );
                        continue;
                    }
                    const previous = versions.get(name);
                    if (previous && previous !== pin)
                        errors.push(
                            `${where}: conflicting direct version ${pin}, already declared ${previous}`,
                        );
                    versions.set(name, pin);
                }
            }
        }
        for (const error of errors) console.error(error);
        return { success: errors.length === 0 };
    }
}

const executor = new VersionsLockedExecutor();
export default executor.run.bind(executor);
