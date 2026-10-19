import { BaseRuleConfig, ConfigObject, FieldDef, ModifiedCodeMode } from '@webpieces/rules-sdk';
import { Option } from '@webpieces/rules-config';
import { SourceSyntax, ts } from '@webpieces/tooling-common/source-syntax';

/**
 * The config entry of one repo-local rule (#1314): the pack's owner file maps the rule's id to it.
 *
 * `mode` is the same scope vocabulary `catch-must-propagate` uses — OFF | NEW_AND_MODIFIED_CODE |
 * NEW_AND_MODIFIED_FILES | MODIFIED_PROJECTS | RUN_EVERY_TIME — and, like every field inherited from
 * BaseRuleConfig (`turnOffRuleUntilEpoch`, `turnOffRuleWhileOnBranch`, `excludePaths`, `reason`), it is
 * applied by the FRAMEWORK in both runners; a rule never reads it. A rule with settings of its own extends
 * this class and declares them (`words!: string[]`), next to the FieldDefs in {@link LocalRule.settings}.
 */
export class LocalRuleConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
}

/**
 * The one file a local rule judges: its WHOLE text, parsed once by `SourceSyntax`. It is the same object
 * in both runners — the Write/Edit guard builds it from the proposed post-edit file, the build gate from
 * the committed file — so a rule that decides from this syntax gives the same verdict at the same line in
 * both. Walk `source` with the `ts` exported beside this class, never a `typescript` of your own.
 */
export class LocalRuleFile {
    constructor(
        /** Workspace-relative, '/'-separated. */
        readonly relativePath: string,
        readonly syntax: SourceSyntax,
    ) {}

    get source(): ts.SourceFile {
        return this.syntax.source;
    }

    get text(): string {
        return this.syntax.source.text;
    }

    /** 1-based line of a node's first non-trivia character — where a finding is reported. */
    lineOf(node: ts.Node): number {
        return this.syntax.lineOf(node);
    }

    /** 1-based line of a node's last character. */
    endLineOf(node: ts.Node): number {
        return this.syntax.endLineOf(node);
    }
}

/**
 * One violation a local rule found. `line` is where it is reported and where a per-site disable aims;
 * `endLine` is the last line of the construct, so under NEW_AND_MODIFIED_CODE a change ANYWHERE in it
 * judges it (pass `line` again for a one-line finding). Data-only.
 */
export class LocalRuleFinding {
    constructor(
        readonly line: number,
        readonly endLine: number,
        /** Why THIS site breaks the rule — the diagnosis; the cures come from {@link LocalRule.cures}. */
        readonly message: string,
    ) {}
}

/**
 * A repo-local rule (#1314): ONE definition that webpieces runs in BOTH places — refused at Write/Edit
 * time by the source guard, and checked by `wp-build` / the PR gate. There is no setting choosing between
 * them; a repo that does not want the write-time check turns the source guard off with its existing
 * switches.
 *
 * The rule decides from the file's SYNTAX alone. The guard sees one proposed file and no compiler program,
 * so anything that needs type information (what an identifier resolves to across files) cannot give the
 * same verdict in both runners and does not belong in a local rule.
 *
 * Everything else is the framework's, exactly as for a built-in rule: `mode` and the changed-line scoping,
 * the epoch and branch switches, `excludePaths`, and the per-site
 * `// webpieces-disable <id> -- <reason>` escape (a reason of at least 20 characters is required). A rule
 * only finds sites.
 */
export abstract class LocalRule<C extends LocalRuleConfig = LocalRuleConfig> {
    /** The rule's id: its key in the owner file and its name in every refusal and disable. Kebab-case. */
    abstract readonly id: string;
    /** One sentence saying what the rule requires. */
    abstract readonly description: string;
    /** Workspace-relative globs of the files it judges (`**\/*.ts`). Both runners judge exactly these. */
    abstract readonly files: readonly string[];
    /** The fixes both runners print under every finding; mark the one to reach for first `preferred`. */
    abstract readonly cures: readonly Option[];
    /**
     * The rule's OWN settings, beyond `mode` and the framework-owned fields — `{}` when it has none. A
     * required field has no default: a missing value fails the config load, naming the entry to paste.
     */
    abstract readonly settings: Readonly<Record<string, FieldDef>>;
    /**
     * The reviewed entry written into the pack's owner file for a human to read: `mode` and every
     * required setting. It is never applied by the loader — the owner file must state each value.
     */
    abstract readonly seed: ConfigObject;

    /** Every site in `file` that breaks the rule. Scoping and disables are applied to what this returns. */
    abstract check(file: LocalRuleFile, config: C): readonly LocalRuleFinding[];
}
