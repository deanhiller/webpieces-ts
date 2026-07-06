/**
 * Framework Resolver
 *
 * Determines the `framework` field (a project's "libType" — the SET of runtime
 * environments it is validated to run in) written per project into
 * architecture/dependencies.json. A project carries a MULTI-VALUE env set drawn
 * from the atomic values:
 *
 *   browser · react · angular · node · express
 *
 * A project lists every environment it promises to run in, e.g.
 * `framework:browser` + `framework:node`. This is the field the
 * `library-types-match-client` rule reads (via the up-set lattice) to keep an
 * express project from depending on a browser-only lib (and vice-versa). The
 * legacy single-value `all` "usable by any side" bucket is REMOVED — a project
 * must declare its actual env set.
 *
 * Resolution order:
 * 1. Explicit nx tags `framework:<value>` on the project (project.json tags) —
 *    any value is allowed so new frameworks need no code change here, and MANY
 *    are allowed (the env set). This is the source of truth; every project
 *    should carry at least one.
 * 2. Inference from the project's package.json dependencies (a single-element
 *    set fallback).
 * 3. FAILURE: no tag and nothing inferable is a problem, never a silent 'all'.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProjectInfo } from './project-info';
import { toError } from '../toError';

export const FRAMEWORK_TAG_PREFIX = 'framework:';

/**
 * A package.json dependency name that identifies a framework.
 */
class FrameworkMarker {
    constructor(
        public readonly dependency: string,
        public readonly framework: string
    ) {}
}

/**
 * Dependency name → framework, checked in order (first match wins).
 */
const FRAMEWORK_DEPENDENCY_MARKERS: ReadonlyArray<FrameworkMarker> = [
    new FrameworkMarker('@angular/core', 'angular'),
    new FrameworkMarker('react', 'react'),
    new FrameworkMarker('express', 'express'),
];

export class FrameworkResolution {
    constructor(
        /** Resolved env set (never empty), or null when resolution failed. */
        public readonly frameworks: string[] | null,
        /** Problem description when resolution failed, otherwise null */
        public readonly problem: string | null
    ) {}
}

export function resolveFramework(info: ProjectInfo, workspaceRoot: string): FrameworkResolution {
    const tagValues = info.tags
        .filter((tag: string) => tag.startsWith(FRAMEWORK_TAG_PREFIX))
        .map((tag: string) => tag.slice(FRAMEWORK_TAG_PREFIX.length).trim());

    if (tagValues.length >= 1) {
        if (tagValues.some((value: string) => value.length === 0)) {
            return new FrameworkResolution(null, `${info.name}: 'framework:' tag has an empty value`);
        }
        // Preserve declaration order, de-duplicating repeated envs.
        return new FrameworkResolution(Array.from(new Set(tagValues)), null);
    }

    const inferred = inferFromPackageJson(info, workspaceRoot);
    if (inferred === null) {
        return new FrameworkResolution(
            null,
            `${info.name}: no 'framework:' tag and no framework inferable from package.json — declare the ` +
                `env set this project runs in, e.g. framework:browser + framework:node`
        );
    }
    return new FrameworkResolution([inferred], null);
}

function inferFromPackageJson(info: ProjectInfo, workspaceRoot: string): string | null {
    const pkgJsonPath = path.join(workspaceRoot, info.root, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
        return null;
    }

    let allDeps: Record<string, string>;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        allDeps = {
            ...(pkgJson.dependencies ?? {}),
            ...(pkgJson.devDependencies ?? {}),
            ...(pkgJson.peerDependencies ?? {}),
        };
    } catch (err: unknown) {
        const error = toError(err);
        throw new Error(`Failed to parse ${pkgJsonPath} while inferring framework for ${info.name}`, {
            cause: error,
        });
    }

    for (const marker of FRAMEWORK_DEPENDENCY_MARKERS) {
        if (marker.dependency in allDeps) {
            return marker.framework;
        }
    }
    return null;
}
