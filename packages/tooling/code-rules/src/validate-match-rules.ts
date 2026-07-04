/**
 * Validate a single `match-rules` entry (a client-authored content guard) at build time.
 *
 * One MatchRulesValidator is constructed PER entry of the `match-rules` array (see validate-code.ts),
 * so `shouldRun()` / mode / epoch apply per entry and the report shows the entry name. The regex
 * matching + allowedPath/test-file exemption is shared with the ai-hook engine via
 * findMatchRuleViolations; this validator adds diff-scoping (mode), the `// webpieces-disable <name>`
 * filter, and the console report (renderMatchRuleMessage — the same text the ai-hook FixHint renders).
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
} from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { shouldSkipRule } from './resolve-mode';

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

export function findViolationsInFile(
    filePath: string,
    workspaceRoot: string,
    config: MatchRuleConfig,
): MatchViolationInfo[] {
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

function findViolationsForModifiedCode(
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

        for (const v of findViolationsInFile(file, workspaceRoot, config)) {
            if (v.hasDisableComment) continue;
            if (!changedLines.has(v.line)) continue;
            violations.push(new MatchViolation(file, v.line, v.context));
        }
    }
    return violations;
}

function findViolationsForModifiedFiles(
    workspaceRoot: string,
    changedFiles: string[],
    config: MatchRuleConfig,
): MatchViolation[] {
    const violations: MatchViolation[] = [];
    for (const file of changedFiles) {
        for (const v of findViolationsInFile(file, workspaceRoot, config)) {
            if (v.hasDisableComment) continue;
            violations.push(new MatchViolation(file, v.line, v.context));
        }
    }
    return violations;
}

function reportViolations(config: MatchRuleConfig, violations: MatchViolation[], mode: ModifiedCodeMode): void {
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

function resolveMode(config: MatchRuleConfig): ModifiedCodeMode {
    const normalMode: ModifiedCodeMode = config.mode ?? 'OFF';
    if (normalMode === 'OFF') return normalMode;
    const skip = shouldSkipRule(config.ignoreModifiedUntilEpoch, config.ignoreRuleWhileOnBranch);
    if (skip.skip) {
        console.log(`\n⏭️  Skipping ${config.name} validation (${skip.reason})`);
        console.log('');
        return 'OFF';
    }
    return normalMode;
}

async function runValidatorImpl(config: MatchRuleConfig, workspaceRoot: string): Promise<ExecutorResult> {
    const mode = resolveMode(config);
    if (mode === 'OFF') {
        console.log(`\n⏭️  Skipping ${config.name} validation (mode: OFF)`);
        console.log('');
        return { success: true };
    }

    console.log(`\n📏 Validating match-rule: ${config.name}\n`);
    console.log(`   Mode: ${mode}`);

    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];
    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;
        if (!base) {
            console.log(`\n⏭️  Skipping ${config.name} validation (could not detect base branch)`);
            console.log('');
            return { success: true };
        }
    }

    console.log(`   Base: ${base}`);
    console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}`);
    console.log('');

    const changedFiles = getChangedFiles(workspaceRoot, base, head);
    if (changedFiles.length === 0) {
        console.log('✅ No TypeScript files changed');
        return { success: true };
    }

    console.log(`📂 Checking ${changedFiles.length} changed file(s)...`);

    let violations: MatchViolation[] = [];
    if (mode === 'NEW_AND_MODIFIED_CODE') {
        violations = findViolationsForModifiedCode(workspaceRoot, changedFiles, base, head, config);
    } else if (mode === 'NEW_AND_MODIFIED_FILES') {
        violations = findViolationsForModifiedFiles(workspaceRoot, changedFiles, config);
    }

    if (violations.length === 0) {
        console.log(`✅ No ${config.name} violations found`);
        return { success: true };
    }

    reportViolations(config, violations, mode);
    return { success: false };
}

export class MatchRulesValidator extends CodeValidator<MatchRuleConfig> {
    constructor(config: MatchRuleConfig) {
        super(config, config.name);
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        return runValidatorImpl(this.config, workspaceRoot);
    }
}
