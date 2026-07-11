/**
 * Validate Framework Tag Executor
 *
 * Every project that a changed source file belongs to must carry at least one
 * `framework:<value>` nx tag in its project.json. Those tags are the project's
 * "libType" — the SET of runtime environments it is validated to run in, drawn
 * from the atomic values:
 *
 *   framework:browser | framework:react | framework:angular
 *   framework:node    | framework:express
 *
 * A project lists EVERY environment it promises to run in (e.g.
 * `framework:browser` + `framework:node`). This env set is the source of truth
 * for the `framework` field written into architecture/dependencies.json and for
 * the `library-types-match-client` rule, which uses the compatibility lattice
 * (react/angular→browser, express→node) to keep an express project from
 * depending on a browser-only library (and vice-versa).
 *
 * The legacy single-value `framework:all` "usable by any side" bucket is
 * REMOVED — it is a hard error, and the author must declare the actual env set.
 *
 * The project-walking + diff-scoping + mode logic is shared with the `role-tag`
 * rule in `tag-rule.ts`; this file supplies only the framework-specific prefix,
 * known values, and violation messages. Unlike role-tag, framework-tag ALSO
 * validates tag VALUES (allowing multiple) via {@link TagRuleSpec.validateValues}.
 *
 * ============================================================================
 * MODES (PROJECT-LEVEL)
 * ============================================================================
 * - OFF:               Skip validation entirely.
 * - MODIFIED_PROJECTS: Require >=1 valid framework tag on every project that
 *                      owns ANY changed file (not just .ts, and not line-scoped).
 */

import { ProjectMode, FrameworkTagConfig } from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { provideSingleton } from '@webpieces/core-context';
import { injectable } from 'inversify';
import {
    InvalidTagProject,
    MissingTagProject,
    TagRuleSpec,
    findProjectsMissingTag,
    runTagValidator,
} from './tag-rule';

const FRAMEWORK_TAG_PREFIX = 'framework:';
const DEFAULT_KNOWN_TYPES = ['browser', 'react', 'angular', 'node', 'express'];

/** The removed legacy libType, kept only to emit a targeted migration message. */
const REMOVED_ALL_VALUE = 'all';

/**
 * Back-compat export used by tests: the framework-tag flavor of the shared
 * missing-tag scan.
 */
export function findUntaggedProjects(workspaceRoot: string, changedFiles: string[]): MissingTagProject[] {
    return findProjectsMissingTag(workspaceRoot, changedFiles, FRAMEWORK_TAG_PREFIX);
}

function reportViolations(untagged: MissingTagProject[], knownTypes: string[], mode: ProjectMode): void {
    const suggestion = knownTypes.map((t: string) => `${FRAMEWORK_TAG_PREFIX}${t}`).join(' | ');
    console.error('');
    console.error('❌ Every modified project must declare the env set it runs in (>=1 framework tag)!');
    console.error('');
    console.error(`   Add ONE OR MORE of these to the project's project.json "tags" array: ${suggestion}`);
    console.error('   (react/angular specialize browser; express specializes node. A project that runs in');
    console.error('    both the browser and node declares BOTH, e.g. framework:browser + framework:node.)');
    console.error('   This libType drives architecture/dependencies.json and the library-types-match-client rule.');
    console.error('');

    for (const project of untagged) {
        console.error(`  ❌ ${project.name} — ${project.projectJsonPath}`);
        console.error(`     add e.g. "tags": ["${FRAMEWORK_TAG_PREFIX}browser", "${FRAMEWORK_TAG_PREFIX}node"]`);
    }
    console.error('');
    console.error(`   Current mode: ${mode}`);
    console.error('');
}

function reportInvalidValues(invalid: InvalidTagProject[], knownTypes: string[], mode: ProjectMode): void {
    const known = knownTypes.map((t: string) => `${FRAMEWORK_TAG_PREFIX}${t}`).join(' | ');
    console.error('');
    console.error('❌ Some modified projects carry an unknown framework tag value!');
    console.error('');
    console.error(`   Allowed values: ${known}`);
    console.error('');

    for (const project of invalid) {
        console.error(`  ❌ ${project.name} — ${project.projectJsonPath}`);
        for (const bad of project.badValues) {
            if (bad === REMOVED_ALL_VALUE) {
                console.error(
                    `     framework:all is removed — declare the actual env set, ` +
                        `e.g. framework:browser + framework:node`
                );
            } else {
                console.error(`     unknown value "${FRAMEWORK_TAG_PREFIX}${bad}" — use one of: ${known}`);
            }
        }
    }
    console.error('');
    console.error(`   Current mode: ${mode}`);
    console.error('');
}

const FRAMEWORK_TAG_SPEC = new TagRuleSpec(
    FRAMEWORK_TAG_PREFIX,
    'framework-tag',
    'Framework Tag',
    DEFAULT_KNOWN_TYPES,
    reportViolations,
    true,
    reportInvalidValues
);

@provideSingleton()
@injectable()
export class FrameworkTagValidator extends CodeValidator<FrameworkTagConfig> {
    constructor(config: FrameworkTagConfig) {
        super(config, 'framework-tag');
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        return runTagValidator(this.config, workspaceRoot, FRAMEWORK_TAG_SPEC);
    }
}
