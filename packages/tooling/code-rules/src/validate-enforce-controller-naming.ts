/**
 * Validate enforce-controller-naming at BUILD time.
 *
 * A controller class (decorated @Controller() OR whose heritage ends in `*Api`) must be named
 * `{Something}Controller` and live in a lower-case kebab file `{something}-controller.ts`. The
 * detection (class scan, controller signal, kebab file-name check) + allowedPaths/test-file
 * exemption is shared with the ai-hook engine via findControllerNamingViolations; this validator
 * adds diff-scoping (mode), the `// webpieces-disable enforce-controller-naming` filter, and the
 * console report. Same skeleton as validate-no-symbol-di-tokens / validate-match-rules.
 *
 * MODES: OFF | NEW_AND_MODIFIED_CODE (violations on changed lines) | NEW_AND_MODIFIED_FILES (any
 * violation in a changed file). Because a controller file's very name is what's checked, the file
 * tier (NEW_AND_MODIFIED_FILES) is the intended setting.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    hasDisable,
    RULE_NAMES,
    EnforceControllerNamingConfig,
    ControllerNamingViolation,
    findControllerNamingViolations,
    ModifiedCodeMode,
    detectBase,
    getChangedFiles,
    getFileDiff,
    getChangedLineNumbers,
} from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { shouldSkipRule } from './resolve-mode';

class NamingViolation {
    readonly file: string;
    readonly line: number;
    readonly context: string;
    readonly message: string;

    constructor(file: string, line: number, context: string, message: string) {
        this.file = file;
        this.line = line;
        this.context = context;
        this.message = message;
    }
}

class NamingViolationInfo {
    readonly line: number;
    readonly context: string;
    readonly message: string;
    readonly hasDisableComment: boolean;

    constructor(line: number, context: string, message: string, hasDisableComment: boolean) {
        this.line = line;
        this.context = context;
        this.message = message;
        this.hasDisableComment = hasDisableComment;
    }
}

function stripLineComment(line: string): string {
    const idx = line.indexOf('//');
    if (idx === -1) return line;
    return line.substring(0, idx);
}

export function findNamingViolationsInFile(
    filePath: string,
    workspaceRoot: string,
    config: EnforceControllerNamingConfig,
): NamingViolationInfo[] {
    // Only .ts/.tsx carry controller classes; skip everything else cheaply.
    if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) return [];

    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const rawLines = content.split('\n');
    // Strip line comments so a commented-out `class Foo extends BarApi` can't false-match (parity
    // with match-rules build-time; the ai-hook engine strips via stripTsNoise upstream).
    const strippedLines = rawLines.map(stripLineComment);

    const hits = findControllerNamingViolations(strippedLines, filePath, config);
    const disableAllowed = config.disableAllowed ?? true;

    return hits.map((hit: ControllerNamingViolation) => {
        const line = rawLines[hit.line - 1] ?? '';
        const prevLine = hit.line > 1 ? (rawLines[hit.line - 2] ?? '') : '';
        const disabled = hasDisable(line, RULE_NAMES.ENFORCE_CONTROLLER_NAMING) || hasDisable(prevLine, RULE_NAMES.ENFORCE_CONTROLLER_NAMING);
        return new NamingViolationInfo(hit.line, hit.context, hit.message, disableAllowed && disabled);
    });
}

function findViolationsForModifiedCode(
    workspaceRoot: string,
    changedFiles: string[],
    base: string,
    head: string | undefined,
    config: EnforceControllerNamingConfig,
): NamingViolation[] {
    const violations: NamingViolation[] = [];
    for (const file of changedFiles) {
        const diff = getFileDiff(workspaceRoot, file, base, head);
        const changedLines = getChangedLineNumbers(diff);
        if (changedLines.size === 0) continue;

        for (const v of findNamingViolationsInFile(file, workspaceRoot, config)) {
            if (v.hasDisableComment) continue;
            if (!changedLines.has(v.line)) continue;
            violations.push(new NamingViolation(file, v.line, v.context, v.message));
        }
    }
    return violations;
}

function findViolationsForModifiedFiles(
    workspaceRoot: string,
    changedFiles: string[],
    config: EnforceControllerNamingConfig,
): NamingViolation[] {
    const violations: NamingViolation[] = [];
    for (const file of changedFiles) {
        for (const v of findNamingViolationsInFile(file, workspaceRoot, config)) {
            if (v.hasDisableComment) continue;
            violations.push(new NamingViolation(file, v.line, v.context, v.message));
        }
    }
    return violations;
}

// webpieces-disable max-lines-new-methods -- Console output with guidance message and violation list
function reportViolations(violations: NamingViolation[], mode: ModifiedCodeMode, disableAllowed: boolean): void {
    console.error('');
    console.error('❌ Controller naming violations (enforce-controller-naming)!');
    console.error('');
    console.error('   Any class implementing/extending an *Api must declare intent: @Controller (then named');
    console.error('   "{Something}Controller" in a "{something}-controller.ts" file) OR @NotController.');
    console.error('');
    for (const v of violations) {
        console.error(`  ❌ ${v.file}:${v.line}`);
        console.error(`     ${v.context}`);
        console.error(`     → ${v.message}`);
    }
    console.error('');
    if (disableAllowed) {
        console.error('   Escape hatch (use sparingly):');
        console.error('   // webpieces-disable enforce-controller-naming -- <reason>');
    } else {
        console.error('   Escape hatch: DISABLED (disableAllowed: false)');
    }
    console.error('');
    console.error(`   Current mode: ${mode}`);
    console.error('');
}

function resolveMode(config: EnforceControllerNamingConfig): ModifiedCodeMode {
    const normalMode: ModifiedCodeMode = config.mode ?? 'OFF';
    if (normalMode === 'OFF') return normalMode;
    const skip = shouldSkipRule(config.ignoreModifiedUntilEpoch, config.ignoreRuleWhileOnBranch);
    if (skip.skip) {
        console.log(`\n⏭️  Skipping enforce-controller-naming validation (${skip.reason})`);
        console.log('');
        return 'OFF';
    }
    return normalMode;
}

async function runValidatorImpl(config: EnforceControllerNamingConfig, workspaceRoot: string): Promise<ExecutorResult> {
    const mode = resolveMode(config);
    const disableAllowed = config.disableAllowed ?? true;

    if (mode === 'OFF') {
        console.log('\n⏭️  Skipping enforce-controller-naming validation (mode: OFF)');
        console.log('');
        return { success: true };
    }

    console.log('\n📏 Validating Controller Naming\n');
    console.log(`   Mode: ${mode}`);

    let base = process.env['NX_BASE'];
    const head = process.env['NX_HEAD'];
    if (!base) {
        base = detectBase(workspaceRoot) ?? undefined;
        if (!base) {
            console.log('\n⏭️  Skipping enforce-controller-naming validation (could not detect base branch)');
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

    let violations: NamingViolation[] = [];
    if (mode === 'NEW_AND_MODIFIED_CODE') {
        violations = findViolationsForModifiedCode(workspaceRoot, changedFiles, base, head, config);
    } else if (mode === 'NEW_AND_MODIFIED_FILES') {
        violations = findViolationsForModifiedFiles(workspaceRoot, changedFiles, config);
    }

    if (violations.length === 0) {
        console.log('✅ No controller naming violations found');
        return { success: true };
    }

    reportViolations(violations, mode, disableAllowed);
    return { success: false };
}

export class EnforceControllerNamingValidator extends CodeValidator<EnforceControllerNamingConfig> {
    constructor(config: EnforceControllerNamingConfig) {
        super(config, 'enforce-controller-naming');
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        return runValidatorImpl(this.config, workspaceRoot);
    }
}
