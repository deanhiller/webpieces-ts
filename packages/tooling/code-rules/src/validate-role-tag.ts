/**
 * Validate Role Tag Executor
 *
 * Every project that a changed source file belongs to must carry a
 * `role:<value>` nx tag in its project.json. That tag is the project's ROLE
 * (orthogonal to its `framework` libType):
 *
 *   role:server | role:designed-lib | role:lib | role:client
 *
 * It is the source of truth for the `role` field written into
 * architecture/dependencies.json, for the `role-dependency` edge rule (apps are
 * never depended upon), and for DI-design generation (server → @DocumentDesign,
 * designed-lib → @DocumentDesign, lib → none, client → angular design).
 *
 * The project-walking + diff-scoping + mode logic is shared with the
 * `framework-tag` rule in `tag-rule.ts`; this file supplies only the
 * role-specific prefix, known values, and violation message.
 */

import { ProjectMode, RoleTagConfig } from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { MissingTagProject, TagRuleSpec, findProjectsMissingTag, runTagValidator } from './tag-rule';

const ROLE_TAG_PREFIX = 'role:';
const DEFAULT_KNOWN_TYPES = ['server', 'designed-lib', 'lib', 'client', 'api-lib'];

/** The role-tag flavor of the shared missing-tag scan (exported for tests). */
export function findRoleUntaggedProjects(workspaceRoot: string, changedFiles: string[]): MissingTagProject[] {
    return findProjectsMissingTag(workspaceRoot, changedFiles, ROLE_TAG_PREFIX);
}

function reportViolations(untagged: MissingTagProject[], knownTypes: string[], mode: ProjectMode): void {
    const suggestion = knownTypes.map((t: string) => `${ROLE_TAG_PREFIX}${t}`).join(' | ');
    console.error('');
    console.error('❌ Every modified project must declare its role (a role tag)!');
    console.error('');
    console.error(`   Add ONE of these to the project's project.json "tags" array: ${suggestion}`);
    console.error('   (server = runnable app · designed-lib = library with a @DocumentDesign DI design ·');
    console.error('    lib = plain library, no design · client = client app e.g. angular.)');
    console.error('   This role drives DI-design generation, the arch graph, and the role-dependency rule.');
    console.error('');

    for (const project of untagged) {
        console.error(`  ❌ ${project.name} — ${project.projectJsonPath}`);
        console.error(`     add e.g. "tags": ["${ROLE_TAG_PREFIX}lib"]`);
    }
    console.error('');
    console.error(`   Current mode: ${mode}`);
    console.error('');
}

const ROLE_TAG_SPEC = new TagRuleSpec(ROLE_TAG_PREFIX, 'role-tag', 'Role Tag', DEFAULT_KNOWN_TYPES, reportViolations);

export class RoleTagValidator extends CodeValidator<RoleTagConfig> {
    constructor(config: RoleTagConfig) {
        super(config, 'role-tag');
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        return runTagValidator(this.config, workspaceRoot, ROLE_TAG_SPEC);
    }
}
