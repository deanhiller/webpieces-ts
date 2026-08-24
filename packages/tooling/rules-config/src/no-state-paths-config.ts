import { FieldDef, SchemaShape } from './field-def';
import { BaseRuleConfig, BASE_RULE_SCHEMA, ModifiedCodeMode, MODIFIED_CODE_MODES } from './rule-configs';

/**
 * The template dirs `no-state-paths-in-templates` looks at when a repo has not said otherwise:
 * webpieces' own instruct-ai templates, which are the generated docs the rule was written for.
 *
 * A consumer repo that generates AI-facing docs from its own templates points `templateDirs` at them;
 * a repo that generates none matches no files and the rule is a no-op. Seeded rather than left empty
 * so the rule arrives doing the job it exists for instead of waiting to be discovered.
 */
export const DEFAULT_TEMPLATE_DIRS: readonly string[] = ['packages/tooling/rules-config/templates'];

/**
 * The path prefixes that must never be RESTATED in a generated doc, only computed.
 *
 * `.webpieces/` is the whole webpieces state tree, and every path under it is per-tree: a linked
 * worktree's state lives at `<primary>/.webpieces/worktrees/<name>/…`, so the relative spelling names
 * a file that does not exist there.
 */
export const DEFAULT_BANNED_STATE_PATH_PREFIXES: readonly string[] = ['.webpieces/'];

/**
 * Bans a hard-coded state path inside a GENERATED-doc template.
 *
 * The incident: `webpieces.git-workflow.md` restated `.webpieces/logs/branch-mutations.log`. That log
 * is per-worktree, so the doc — regenerated into every governed repo and handed to an agent by
 * absolute path as instruction — named a file that does not exist in half the trees that read it.
 * Every one of these paths already has a resolver; the template engine already substitutes. The rule
 * makes "restate it" the thing that fails and "render `{{PLACEHOLDER}}` from the resolver" the thing
 * that passes.
 *
 * Diff-scoped like every other code rule, so the docs whose SUBJECT is the layout (they explain both
 * rows on purpose) are not retroactively flooded — the rule bites when a template is next edited.
 * A doc that genuinely has to print the literal says so out loud:
 * `<!-- webpieces-disable no-state-paths-in-templates -- this table IS the layout -->`.
 */
export class NoStatePathsInTemplatesConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    disableAllowed?: boolean;
    templateDirs?: string[];
    bannedPathPrefixes?: string[];

    static readonly SCHEMA: SchemaShape<NoStatePathsInTemplatesConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        templateDirs: FieldDef.optional('string[]'),
        bannedPathPrefixes: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}
