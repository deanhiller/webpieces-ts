/**
 * Framework Resolver
 *
 * Determines the `framework` field (a project's "libType" — which client side
 * it targets) written per project into architecture/dependencies.json. Known
 * values: angular | react | express | all ("all" = a library usable by any
 * side). This is the field the `library-types-match-client` rule reads to keep
 * an express project from depending on an angular-only lib (and vice-versa).
 *
 * Resolution order:
 * 1. Explicit nx tag `framework:<value>` on the project (project.json tags) —
 *    any value is allowed so new frameworks need no code change here. This is
 *    the source of truth; every project should carry one.
 * 2. Inference from the project's package.json dependencies.
 * 3. Fallback: 'all' (plain TypeScript library usable by any side).
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
        /** Resolved framework name, or null when resolution failed */
        public readonly framework: string | null,
        /** Problem description when resolution failed, otherwise null */
        public readonly problem: string | null
    ) {}
}

export function resolveFramework(info: ProjectInfo, workspaceRoot: string): FrameworkResolution {
    const tagValues = info.tags
        .filter((tag: string) => tag.startsWith(FRAMEWORK_TAG_PREFIX))
        .map((tag: string) => tag.slice(FRAMEWORK_TAG_PREFIX.length).trim());

    if (tagValues.length > 1) {
        return new FrameworkResolution(
            null,
            `${info.name}: has ${tagValues.length} 'framework:' tags (${tagValues.join(', ')}) — a project must have at most one`
        );
    }
    if (tagValues.length === 1) {
        if (tagValues[0].length === 0) {
            return new FrameworkResolution(null, `${info.name}: 'framework:' tag has an empty value`);
        }
        return new FrameworkResolution(tagValues[0], null);
    }

    return new FrameworkResolution(inferFromPackageJson(info, workspaceRoot), null);
}

function inferFromPackageJson(info: ProjectInfo, workspaceRoot: string): string {
    const pkgJsonPath = path.join(workspaceRoot, info.root, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
        return 'all';
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
    return 'all';
}
