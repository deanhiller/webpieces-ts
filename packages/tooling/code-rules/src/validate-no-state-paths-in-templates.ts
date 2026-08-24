/**
 * Validate No State Paths In Templates
 *
 * FAILS when a GENERATED-doc template restates a webpieces state path (`.webpieces/…`) as a literal
 * instead of rendering it from the resolver that already computes it.
 *
 * ## The incident this exists for
 *
 * `webpieces.git-workflow.md` — an AI-instruction doc regenerated into `.webpieces/instruct-ai/` of
 * every governed repo on every `wp-*` command — carried the literal
 * `.webpieces/logs/branch-mutations.log`. That log is deliberately PER-WORKTREE (one appender each):
 *
 *   primary clone   → `<primary>/.webpieces/logs/branch-mutations.log`
 *   linked worktree → `<primary>/.webpieces/worktrees/<name>/logs/branch-mutations.log`
 *
 * So in a linked worktree the doc named a file that DOES NOT EXIST. The reader greps nothing, and the
 * silence reads as "no deletions were logged" — the opposite of the truth, from the one file whose
 * entire job is to prove every deletion is recoverable.
 *
 * The cure is not "fix that line". Every one of these paths already has a resolver, and the template
 * engine already substitutes (`{{MERGE_DIR}}`, `{{RUN_STATE}}`, `{{BRANCH_MUTATION_LOG}}` …). This
 * rule makes RESTATING the thing that fails and RENDERING the thing that passes, so the next one
 * cannot land.
 *
 * ## Scope
 *
 * `templateDirs` (workspace-relative dirs, recursive, `.md` only) — default
 * `packages/tooling/rules-config/templates`. A repo that generates no AI docs matches no files and the
 * rule is a no-op. Deliberately NOT widened to `backlog/**` (frozen records of past requests — editing
 * them falsifies the record) or to hand-written docs that name a FILE rather than a path.
 *
 * MODES: OFF | NEW_AND_MODIFIED_CODE (changed lines only) | NEW_AND_MODIFIED_FILES (whole changed file).
 * Diff-scoped by default, so the docs whose SUBJECT is the layout (they print both rows on purpose)
 * are not retroactively flooded — the rule bites when a template is next edited.
 *
 * ESCAPE HATCH (this table IS the layout, and printing it is the point):
 *   <!-- webpieces-disable no-state-paths-in-templates -- <reason> -->
 *
 * `~/.webpieces/…` is NOT a violation: the machine-local tier has no per-tree resolver and no
 * per-tree answer, so the literal is the correct and only spelling of it.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    hasDisable,
    RULE_NAMES,
    NoStatePathsInTemplatesConfig,
    Option,
    RuleFailError,
    DEFAULT_TEMPLATE_DIRS,
    DEFAULT_BANNED_STATE_PATH_PREFIXES,
    ModifiedCodeMode,
    detectBase,
    getChangedFiles,
    getFileDiff,
    getChangedLineNumbers,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { CodeValidator, ExecutorResult } from './code-validator';
import { shouldSkipRule } from './resolve-mode';

/** One restated state path, located in a template. */
export class StatePathViolation {
    constructor(
        readonly file: string,
        readonly line: number,
        readonly column: number,
        readonly detail: string,
    ) {}
}

/** One restated state path within a single file, plus whether its line carries a disable. */
export class StatePathHit {
    constructor(
        readonly line: number,
        readonly column: number,
        readonly detail: string,
        readonly hasDisableComment: boolean,
    ) {}
}

@injectable(bindingScopeValues.Singleton)
export class NoStatePathsInTemplatesValidator extends CodeValidator<NoStatePathsInTemplatesConfig> {
    constructor(config: NoStatePathsInTemplatesConfig) {
        super(config, RULE_NAMES.NO_STATE_PATHS_IN_TEMPLATES, RULE_NAMES.NO_STATE_PATHS_IN_TEMPLATES);
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        const opts = this.config;
        const mode = this.resolveMode(
            opts.mode ?? 'NEW_AND_MODIFIED_CODE', opts.turnOffRuleUntilEpoch, opts.turnOffRuleWhileOnBranch ?? undefined);
        const disableAllowed = opts.disableAllowed ?? true;
        if (mode === 'OFF') {
            console.log('\n⏭️  Skipping no-state-paths-in-templates validation (mode: OFF)\n');
            return { success: true };
        }

        console.log('\n📏 Validating No State Paths In Templates\n');
        console.log(`   Mode: ${mode}`);

        let base = process.env['NX_BASE'];
        const head = process.env['NX_HEAD'];
        if (base === undefined || base === '') {
            base = detectBase(workspaceRoot) ?? undefined;
            if (base === undefined || base === '') {
                console.log('\n⏭️  Skipping no-state-paths-in-templates validation (could not detect base branch)\n');
                return { success: true };
            }
        }
        console.log(`   Base: ${base}`);
        console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}\n`);

        const changedFiles = getChangedFiles(workspaceRoot, base, head, { tsOnly: false })
            .filter((file: string): boolean => this.isRelevantFile(file));
        if (changedFiles.length === 0) {
            console.log('✅ No generated-doc templates changed');
            return { success: true };
        }
        console.log(`📂 Checking ${String(changedFiles.length)} changed template(s)...`);

        const violations = mode === 'NEW_AND_MODIFIED_CODE'
            ? this.violationsForModifiedCode(workspaceRoot, changedFiles, base, head, disableAllowed)
            : this.violationsForModifiedFiles(workspaceRoot, changedFiles, disableAllowed);

        if (violations.length === 0) {
            console.log('✅ No hard-coded state paths in generated-doc templates');
            return { success: true };
        }
        throw this.failure(violations, mode);
    }

    /**
     * The ONE spelling of "this validator failed": a thrown {@link RuleFailError} carrying its cures as
     * `Option[]`, which {@link RuleReporter} catches and renders.
     *
     * NOT `console.error` + `{ success: false }`. That pair is a second spelling of the same fact (see
     * RuleReporter.runValidators, which calls it a back-compat shim scheduled for deletion), and
     * hand-written "To fix: … / Escape hatch: …" prose is a second spelling of `Option[]` — the
     * framework owns the `Fix Option N:` numbering and the `(preferred)` tag, so a rule never writes them.
     */
    private failure(violations: StatePathViolation[], mode: ModifiedCodeMode): RuleFailError {
        const detail = violations.map((violation: StatePathViolation): string =>
            `  ${violation.file}:${String(violation.line)}:${String(violation.column)} restates \`${violation.detail}…\``)
            .join('\n');
        const first = violations[0];
        return new RuleFailError(
            RULE_NAMES.NO_STATE_PATHS_IN_TEMPLATES,
            'A generated-doc template RESTATES a webpieces state path instead of computing it. These docs are '
            + 'regenerated into every governed repo and handed to an agent by absolute path AS INSTRUCTION, and '
            + 'every .webpieces/ path is per-tree — a linked worktree keeps its state under '
            + `<primary>/.webpieces/worktrees/<name>/ — so the relative spelling names a file that DOES NOT EXIST `
            + `in half the trees that read it. Current mode: ${mode}.\n${detail}`,
            first?.line,
            first?.detail,
            [
                new Option(
                    'Put a {{PLACEHOLDER}} in the template and render it from the resolver that already computes '
                    + 'that path, the way {{BRANCH_MUTATION_LOG}} is rendered from '
                    + 'BranchMutationLog.branchMutationLogPath(root) in GitWorkflowDoc.render',
                    true),
                new Option(
                    'If the doc\'s SUBJECT is the layout and printing the literal is the point, say so out loud:\n'
                    + '<!-- webpieces-disable no-state-paths-in-templates -- <reason> -->'),
            ],
        );
    }

    /**
     * A changed file this rule looks at: a `.md` under one of the configured template dirs.
     *
     * The ONE place the file set is narrowed, so both modes run over the same list and a scope change
     * cannot be applied in one and forgotten in the other.
     */
    isRelevantFile(file: string): boolean {
        const norm = file.replace(/\\/g, '/');
        if (!norm.endsWith('.md')) return false;
        return this.templateDirs().some((dir: string): boolean => norm.startsWith(`${dir}/`));
    }

    /** Every restated state path in `text`, one hit per line (the first match on that line). */
    findHits(text: string): StatePathHit[] {
        const lines = text.split('\n');
        const hits: StatePathHit[] = [];
        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i] ?? '';
            for (const prefix of this.bannedPrefixes()) {
                const column = this.columnOf(raw, prefix);
                if (column < 0) continue;
                hits.push(new StatePathHit(i + 1, column + 1, prefix, this.hasDisableComment(lines, i + 1)));
                break;
            }
        }
        return hits;
    }

    /**
     * Where `prefix` is restated in `raw`, or -1.
     *
     * `~/.webpieces/…` is skipped: the machine-local tier is the same absolute path from every tree, so
     * there is no resolver to call and the literal is the only spelling there is. Everything else —
     * including the bare relative form that started this — is a restatement of a per-tree path.
     */
    private columnOf(raw: string, prefix: string): number {
        let from = 0;
        for (;;) {
            const at = raw.indexOf(prefix, from);
            if (at < 0) return -1;
            if (raw.slice(Math.max(0, at - 2), at) !== '~/') return at;
            from = at + 1;
        }
    }

    /** NEW_AND_MODIFIED_CODE: only hits whose line is in the diff hunks. */
    private violationsForModifiedCode(
        workspaceRoot: string,
        changedFiles: string[],
        base: string,
        head: string | undefined,
        disableAllowed: boolean,
    ): StatePathViolation[] {
        const violations: StatePathViolation[] = [];
        for (const file of changedFiles) {
            const changedLines = getChangedLineNumbers(getFileDiff(workspaceRoot, file, base, head));
            if (changedLines.size === 0) continue;
            for (const hit of this.hitsForFile(file, workspaceRoot)) {
                if (disableAllowed && hit.hasDisableComment) continue;
                if (!changedLines.has(hit.line)) continue;
                violations.push(new StatePathViolation(file, hit.line, hit.column, hit.detail));
            }
        }
        return violations;
    }

    /** NEW_AND_MODIFIED_FILES: every hit in any changed template. */
    private violationsForModifiedFiles(
        workspaceRoot: string,
        changedFiles: string[],
        disableAllowed: boolean,
    ): StatePathViolation[] {
        const violations: StatePathViolation[] = [];
        for (const file of changedFiles) {
            for (const hit of this.hitsForFile(file, workspaceRoot)) {
                if (disableAllowed && hit.hasDisableComment) continue;
                violations.push(new StatePathViolation(file, hit.line, hit.column, hit.detail));
            }
        }
        return violations;
    }

    private hitsForFile(file: string, workspaceRoot: string): StatePathHit[] {
        const fullPath = path.join(workspaceRoot, file);
        if (!fs.existsSync(fullPath)) return [];
        return this.findHits(fs.readFileSync(fullPath, 'utf-8'));
    }

    private templateDirs(): readonly string[] {
        const dirs = this.config.templateDirs ?? DEFAULT_TEMPLATE_DIRS;
        return dirs.map((dir: string): string => dir.replace(/\\/g, '/').replace(/\/+$/, ''));
    }

    private bannedPrefixes(): readonly string[] {
        return this.config.bannedPathPrefixes ?? DEFAULT_BANNED_STATE_PATH_PREFIXES;
    }

    /** True if a `webpieces-disable no-state-paths-in-templates` sits on this line or up to 3 above. */
    private hasDisableComment(lines: string[], lineNumber: number): boolean {
        const start = Math.max(0, lineNumber - 4);
        for (let i = lineNumber - 1; i >= start; i--) {
            if (hasDisable(lines[i] ?? '', RULE_NAMES.NO_STATE_PATHS_IN_TEMPLATES)) return true;
        }
        return false;
    }

    private resolveMode(
        normalMode: ModifiedCodeMode,
        epoch: number | undefined,
        branchPattern: string | undefined,
    ): ModifiedCodeMode {
        if (normalMode === 'OFF') return normalMode;
        const skip = shouldSkipRule(epoch, branchPattern);
        if (skip.skip) {
            console.log(`\n⏭️  Skipping no-state-paths-in-templates validation (${skip.reason})\n`);
            return 'OFF';
        }
        return normalMode;
    }
}
