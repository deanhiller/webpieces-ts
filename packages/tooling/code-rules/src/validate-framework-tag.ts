/**
 * Validate Framework Tag Executor
 *
 * Every project that a changed source file belongs to must carry a
 * `framework:<value>` nx tag in its project.json. That tag is the project's
 * "libType" — which client side it targets:
 *
 *   framework:angular | framework:react | framework:express | framework:all
 *
 * ("all" = a library usable by any side.) It is the source of truth for the
 * `framework` field written into architecture/dependencies.json and for the
 * `library-types-match-client` rule, which uses it to keep an express project
 * from depending on an angular-only library (and vice-versa).
 *
 * The project-walking + diff-scoping + mode logic is shared with the `role-tag`
 * rule in `tag-rule.ts`; this file supplies only the framework-specific prefix,
 * known values, and violation message.
 *
 * ============================================================================
 * MODES (PROJECT-LEVEL)
 * ============================================================================
 * - OFF:               Skip validation entirely.
 * - MODIFIED_PROJECTS: Require a framework tag on every project that owns ANY
 *                      changed file (not just .ts, and not line-scoped).
 */

import { ProjectMode, FrameworkTagConfig } from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { MissingTagProject, TagRuleSpec, findProjectsMissingTag, runTagValidator } from './tag-rule';

const FRAMEWORK_TAG_PREFIX = 'framework:';
const DEFAULT_KNOWN_TYPES = ['angular', 'react', 'express', 'all'];

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
    console.error('❌ Every modified project must declare which client side it targets (a framework tag)!');
    console.error('');
    console.error(`   Add ONE of these to the project's project.json "tags" array: ${suggestion}`);
    console.error('   ("all" = a library usable by any side — angular, react and express can all import it.)');
    console.error('   This libType drives architecture/dependencies.json and the library-types-match-client rule.');
    console.error('');

    for (const project of untagged) {
        console.error(`  ❌ ${project.name} — ${project.projectJsonPath}`);
        console.error(`     add e.g. "tags": ["${FRAMEWORK_TAG_PREFIX}all"]`);
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
    reportViolations
);

export class FrameworkTagValidator extends CodeValidator<FrameworkTagConfig> {
    constructor(config: FrameworkTagConfig) {
        super(config, 'framework-tag');
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        return runTagValidator(this.config, workspaceRoot, FRAMEWORK_TAG_SPEC);
    }
}
