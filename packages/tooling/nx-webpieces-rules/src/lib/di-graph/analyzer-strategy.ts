/**
 * DI Analyzer Strategy
 *
 * Picks which DI analyzer generates a project's design graph, driven by the
 * project's `framework` nx tag (see the framework/libType tagging PR):
 *
 *   - `express` → {@link InversifyAnalyzer} (roots on `@Controller`)
 *   - `angular` → {@link AngularAnalyzer}  (roots on the bootstrap/route components)
 *   - anything else (`react`, `all`, ...) → {@link EmptyAnalyzer} (skip; the
 *     controller-less library top-of-DAG behavior is deferred for v1)
 *
 * The explicit tag is the source of truth. When it is ABSENT (e.g. before the
 * tagging PR lands), a cheap marker pre-scan corroborates: `@Component(` /
 * `bootstrapApplication` → angular; `@Controller(` → express. This makes the
 * committed design.* identical whether selection is tag- or marker-driven.
 */

import type * as ts from 'typescript';
import { DiGraph } from './model';
import { buildDiGraph } from './analyzer';
import { buildAngularDiGraph } from './angular-analyzer';

const FRAMEWORK_TAG_PREFIX = 'framework:';

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

/** Inversify (express): one design per `@Controller` root. Library roots deferred (v1). */
export class InversifyAnalyzer implements DiAnalyzer {
    analyzeProject(program: ts.Program, workspaceRoot: string, projectRoot: string, projectName: string): DiGraph {
        return buildDiGraph(program, workspaceRoot, projectRoot, projectName);
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

/** Extract the explicit `framework:<value>` nx tag, or null when the project has none. */
export function explicitFrameworkTag(tags: readonly string[]): string | null {
    for (const tag of tags) {
        if (tag.startsWith(FRAMEWORK_TAG_PREFIX)) {
            const value = tag.slice(FRAMEWORK_TAG_PREFIX.length).trim();
            if (value.length > 0) return value;
        }
    }
    return null;
}

/**
 * Choose the analyzer for a project. `framework` is the EXPLICIT tag value (or
 * null); `markers` is only consulted when the tag is absent.
 */
export function selectAnalyzer(framework: string | null, markers: FrameworkMarkers): DiAnalyzer {
    if (framework === 'express') return new InversifyAnalyzer();
    if (framework === 'angular') return new AngularAnalyzer();
    if (framework !== null) return new EmptyAnalyzer();

    // Tag absent — fall back to marker corroboration.
    if (markers.angular) return new AngularAnalyzer();
    if (markers.controller) return new InversifyAnalyzer();
    return new EmptyAnalyzer();
}
