/**
 * Validate `match-rules` entries (client-authored content guards) at build time.
 *
 * A config-free, injected checker: the {@link CodeRulesEngine} injects ONE MatchRulesChecker and runs
 * it once per `match-rules` entry (config passed to the method), so there is no `new` of a DAG member.
 * `shouldRun` / mode / epoch apply per entry and the report shows the entry name. The regex matching +
 * allowedPath/test-file exemption is shared with the ai-hook engine via findMatchRuleViolations; this
 * adds diff-scoping (mode), the `// webpieces-disable <name>` filter, and the console report.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    hasDisable,
    MatchRuleConfig,
    MatchRuleViolation,
    findMatchRuleViolations,
    renderMatchRuleMessage,
    ModifiedCodeMode,
    detectBase,
    getChangedFiles,
    getFileDiff,
    getChangedLineNumbers,
    shouldSkipRule,
} from '@webpieces/rules-config';
import { provideSingleton } from '@webpieces/rules-config';
import { injectable } from 'inversify';
import { ExecutorResult } from './code-validator';

class MatchViolation {
    readonly file: string;
    readonly line: number;
    readonly context: string;

    constructor(file: string, line: number, context: string) {
        this.file = file;
        this.line = line;
        this.context = context;
    }
}

export class MatchViolationInfo {
    readonly line: number;
    readonly context: string;
    readonly hasDisableComment: boolean;

    constructor(line: number, context: string, hasDisableComment: boolean) {
        this.line = line;
        this.context = context;
        this.hasDisableComment = hasDisableComment;
    }
}

@provideSingleton()
@injectable()
export class MatchRulesChecker {
    /** True unless this entry is `mode: "OFF"` or skipped by a branch/epoch escape hatch. */
    shouldRun(config: MatchRuleConfig): boolean {
        if ((config.mode ?? 'OFF') === 'OFF') return false;
        return !shouldSkipRule(config.ignoreModifiedUntilEpoch, config.ignoreRuleWhileOnBranch).skip;
    }

    /** Run one `match-rules` entry against the workspace (per-entry mode/diff-scoping/report). */
    async runForConfig(config: MatchRuleConfig, workspaceRoot: string): Promise<ExecutorResult> {
        const mode = this.resolveMode(config);
        if (mode === 'OFF') {
            console.log(`\n⏭️  Skipping ${config.name} validation (mode: OFF)\n`);
            return { success: true };
        }

        console.log(`\n📏 Validating match-rule: ${config.name}\n`);
        console.log(`   Mode: ${mode}`);

        let base = process.env['NX_BASE'];
        const head = process.env['NX_HEAD'];
        if (!base) {
            base = detectBase(workspaceRoot) ?? undefined;
            if (!base) {
                console.log(`\n⏭️  Skipping ${config.name} validation (could not detect base branch)\n`);
                return { success: true };
            }
        }

        console.log(`   Base: ${base}`);
        console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}\n`);

        const changedFiles = getChangedFiles(workspaceRoot, base, head);
        if (changedFiles.length === 0) {
            console.log('✅ No TypeScript files changed');
            return { success: true };
        }

        console.log(`📂 Checking ${changedFiles.length} changed file(s)...`);
        const violations = mode === 'NEW_AND_MODIFIED_CODE'
            ? this.findViolationsForModifiedCode(workspaceRoot, changedFiles, base, head, config)
            : this.findViolationsForModifiedFiles(workspaceRoot, changedFiles, config);

        if (violations.length === 0) {
            console.log(`✅ No ${config.name} violations found`);
            return { success: true };
        }

        this.reportViolations(config, violations, mode);
        return { success: false };
    }

    findViolationsInFile(filePath: string, workspaceRoot: string, config: MatchRuleConfig): MatchViolationInfo[] {
        const fullPath = path.join(workspaceRoot, filePath);
        if (!fs.existsSync(fullPath)) return [];

        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');

        // Shared engine applies allowedPaths + test-file exemption and regex matching.
        const hits = findMatchRuleViolations(lines, filePath, config);
        const disableAllowed = config.disableAllowed ?? true;

        return hits.map((hit: MatchRuleViolation) => {
            const line = lines[hit.line - 1] ?? '';
            const prevLine = hit.line > 1 ? (lines[hit.line - 2] ?? '') : '';
            const disabled = hasDisable(line, config.name) || hasDisable(prevLine, config.name);
            return new MatchViolationInfo(hit.line, hit.context, disableAllowed && disabled);
        });
    }

    private findViolationsForModifiedCode(
        workspaceRoot: string,
        changedFiles: string[],
        base: string,
        head: string | undefined,
        config: MatchRuleConfig,
    ): MatchViolation[] {
        const violations: MatchViolation[] = [];
        for (const file of changedFiles) {
            const diff = getFileDiff(workspaceRoot, file, base, head);
            const changedLines = getChangedLineNumbers(diff);
            if (changedLines.size === 0) continue;

            for (const v of this.findViolationsInFile(file, workspaceRoot, config)) {
                if (v.hasDisableComment) continue;
                if (!changedLines.has(v.line)) continue;
                violations.push(new MatchViolation(file, v.line, v.context));
            }
        }
        return violations;
    }

    private findViolationsForModifiedFiles(
        workspaceRoot: string,
        changedFiles: string[],
        config: MatchRuleConfig,
    ): MatchViolation[] {
        const violations: MatchViolation[] = [];
        for (const file of changedFiles) {
            for (const v of this.findViolationsInFile(file, workspaceRoot, config)) {
                if (v.hasDisableComment) continue;
                violations.push(new MatchViolation(file, v.line, v.context));
            }
        }
        return violations;
    }

    private reportViolations(config: MatchRuleConfig, violations: MatchViolation[], mode: ModifiedCodeMode): void {
        console.error('');
        console.error(`❌ [${config.name}] matched disallowed pattern(s)!`);
        console.error('');
        console.error(renderMatchRuleMessage(config));
        console.error('');
        for (const v of violations) {
            console.error(`  ❌ ${v.file}:${v.line}`);
            console.error(`     ${v.context}`);
        }
        console.error('');
        console.error(`   Current mode: ${mode}`);
        console.error('');
    }

    private resolveMode(config: MatchRuleConfig): ModifiedCodeMode {
        const normalMode: ModifiedCodeMode = config.mode ?? 'OFF';
        if (normalMode === 'OFF') return normalMode;
        const skip = shouldSkipRule(config.ignoreModifiedUntilEpoch, config.ignoreRuleWhileOnBranch);
        if (skip.skip) {
            console.log(`\n⏭️  Skipping ${config.name} validation (${skip.reason})\n`);
            return 'OFF';
        }
        return normalMode;
    }
}
