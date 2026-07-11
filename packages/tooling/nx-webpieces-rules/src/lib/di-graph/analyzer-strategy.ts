/**
 * DI Analyzer Strategy
 *
 * Picks which DI analyzer generates a project's design graph. The primary
 * driver is the project's `role` nx tag; the `framework` env set (its libType)
 * only distinguishes the client runtime by set membership:
 *
 *   - env set includes `express` → {@link InversifyAnalyzer} (roots on `@DocumentDesign`)
 *   - env set includes `angular` → {@link AngularAnalyzer}  (roots on the bootstrap/route components)
 *   - anything else (`react`, `browser`, `node`, ...) → {@link EmptyAnalyzer} (skip)
 *
 * The explicit tags are the source of truth. When the role tag is ABSENT (e.g.
 * before retag), a cheap marker pre-scan corroborates: `@Component(` /
 * `bootstrapApplication` → angular; `@DocumentDesign(` → Inversify. This makes the
 * committed design.* identical whether selection is tag- or marker-driven.
 */

import type * as ts from 'typescript';
import { DiGraph } from './model';
import { buildDiGraph, DiRootMode } from './analyzer';
import { buildAngularDiGraph } from './angular-analyzer';

const FRAMEWORK_TAG_PREFIX = 'framework:';
const ROLE_TAG_PREFIX = 'role:';

/** Which framework a source tree's decorators point at (marker pre-scan fallback). */
export class FrameworkMarkers {
    angular: boolean;
    controller: boolean;

    constructor(angular: boolean, controller: boolean) {
        this.angular = angular;
        this.controller = controller;
    }
}

/** Statically analyzes one project's DI dependency DAG into a `DiGraph`. */
export interface DiAnalyzer {
    analyzeProject(program: ts.Program, workspaceRoot: string, projectRoot: string, projectName: string): DiGraph;
}

/**
 * Inversify analyzer: one design per `@DocumentDesign` root. The `rootMode` only
 * sets the root box kind:
 *  - `'controller'` (server projects) → `controller`.
 *  - `'apiImplementation'` (role:designed-lib) → `apiImplementation`.
 */
export class InversifyAnalyzer implements DiAnalyzer {
    private readonly rootMode: DiRootMode;

    constructor(rootMode: DiRootMode = 'controller') {
        this.rootMode = rootMode;
    }

    analyzeProject(program: ts.Program, workspaceRoot: string, projectRoot: string, projectName: string): DiGraph {
        return buildDiGraph(program, workspaceRoot, projectRoot, projectName, false, this.rootMode);
    }
}

/** Angular: one design per entry component (bootstrap + routed). */
export class AngularAnalyzer implements DiAnalyzer {
    analyzeProject(program: ts.Program, workspaceRoot: string, projectRoot: string, projectName: string): DiGraph {
        return buildAngularDiGraph(program, workspaceRoot, projectRoot, projectName);
    }
}

/** Non-angular/non-express projects: an empty graph (skip). */
export class EmptyAnalyzer implements DiAnalyzer {
    analyzeProject(
        _program: ts.Program,
        _workspaceRoot: string,
        _projectRoot: string,
        projectName: string,
    ): DiGraph {
        return new DiGraph(projectName);
    }
}

/** Extract the explicit `<prefix><value>` nx tag, or null when the project has none. */
function explicitTag(tags: readonly string[], prefix: string): string | null {
    for (const tag of tags) {
        if (tag.startsWith(prefix)) {
            const value = tag.slice(prefix.length).trim();
            if (value.length > 0) return value;
        }
    }
    return null;
}

/** Extract the FIRST explicit `framework:<value>` nx tag, or null when the project has none. */
export function explicitFrameworkTag(tags: readonly string[]): string | null {
    return explicitTag(tags, FRAMEWORK_TAG_PREFIX);
}

/** Extract every explicit `framework:<value>` nx tag as an env set (the project's libType). */
export function frameworkTags(tags: readonly string[]): string[] {
    const values: string[] = [];
    for (const tag of tags) {
        if (tag.startsWith(FRAMEWORK_TAG_PREFIX)) {
            const value = tag.slice(FRAMEWORK_TAG_PREFIX.length).trim();
            if (value.length > 0) values.push(value);
        }
    }
    return values;
}

/** Extract the explicit `role:<value>` nx tag, or null when the project has none. */
export function explicitRoleTag(tags: readonly string[]): string | null {
    return explicitTag(tags, ROLE_TAG_PREFIX);
}

/**
 * Choose the analyzer for a project. `role` (server|designed-lib|lib|client) is
 * the source of truth for WHAT to root on; `frameworks` is the project's env set
 * (its libType) and distinguishes the client runtime (angular vs other) by set
 * membership; `markers` corroborate only when the role tag is ABSENT (rollout
 * fallback keeps pre-retag designs identical).
 *
 *  - `server`       → Inversify, roots on `@DocumentDesign` (controller kind)
 *  - `app`          → Inversify, roots on `@DocumentDesign` (controller kind) — a runnable
 *                     (non-HTTP) application bootstrapped via `container.get(XxxApp)`, e.g. the
 *                     tooling packages (AiRulesApp, RulesApp). Drawn exactly like a server.
 *  - `designed-lib` → Inversify, roots on `@DocumentDesign` (apiImplementation kind)
 *  - `client`       → Angular design for angular apps; otherwise skip
 *  - `lib`          → skip (plain libraries get no design)
 *  - `api-lib`      → skip (contract-only libraries get no design)
 *  - role absent    → legacy framework/marker selection
 */
export function selectAnalyzer(
    role: string | null,
    frameworks: string[],
    markers: FrameworkMarkers,
): DiAnalyzer {
    if (role === 'server') return new InversifyAnalyzer('controller');
    if (role === 'app') return new InversifyAnalyzer('controller');
    if (role === 'designed-lib') return new InversifyAnalyzer('apiImplementation');
    if (role === 'client') return frameworks.includes('angular') ? new AngularAnalyzer() : new EmptyAnalyzer();
    if (role === 'lib') return new EmptyAnalyzer();
    if (role === 'api-lib') return new EmptyAnalyzer();

    // Role tag absent — fall back to the legacy framework/marker selection so
    // designs stay identical until a project is retagged.
    if (frameworks.includes('express')) return new InversifyAnalyzer('controller');
    if (frameworks.includes('angular')) return new AngularAnalyzer();
    if (frameworks.length > 0) return new EmptyAnalyzer();
    if (markers.angular) return new AngularAnalyzer();
    if (markers.controller) return new InversifyAnalyzer('controller');
    return new EmptyAnalyzer();
}
