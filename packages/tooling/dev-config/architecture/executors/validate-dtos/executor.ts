/**
 * Validate DTOs Executor
 *
 * Validates that every non-deprecated field in a XxxDto class/interface exists
 * in the corresponding XxxDbo Prisma model. This catches AI agents inventing
 * field names that don't match the database schema.
 *
 * ============================================================================
 * MODES
 * ============================================================================
 * - OFF:            Skip validation entirely
 * - MODIFIED_CLASS: Only validate Dto classes that have changed lines in the diff
 * - MODIFIED_FILES: Validate ALL Dto classes in files that were modified
 *
 * ============================================================================
 * SKIP CONDITIONS
 * ============================================================================
 * - If schema.prisma itself is modified, validation is skipped (schema in flux)
 * - Dto classes ending with "JoinDto" are skipped (they compose other Dtos)
 * - Fields marked @deprecated in a comment are exempt
 *
 * ============================================================================
 * MATCHING
 * ============================================================================
 * - UserDto matches UserDbo by case-insensitive prefix ("user")
 * - Dbo field names are converted from snake_case to camelCase for comparison
 * - Dto fields must be a subset of Dbo fields
 * - Extra Dbo fields are allowed (e.g., password)
 */

import type { ExecutorContext } from '@nx/devkit';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export type ValidateDtosMode = 'OFF' | 'MODIFIED_CLASS' | 'MODIFIED_FILES';

export interface ValidateDtosOptions {
    mode?: ValidateDtosMode;
    disableAllowed?: boolean;
    prismaSchemaPath?: string;
    dtoSourcePaths?: string[];
    ignoreModifiedUntilEpoch?: number;
}

export interface ExecutorResult {
    success: boolean;
}

interface DtoFieldInfo {
    name: string;
    line: number;
    deprecated: boolean;
}

interface DtoInfo {
    name: string;
    file: string;
    startLine: number;
    endLine: number;
    fields: DtoFieldInfo[];
}

interface DtoViolation {
    file: string;
    line: number;
    dtoName: string;
    fieldName: string;
    dboName: string;
    availableFields: string[];
}

interface DboEntry {
    name: string;
    fields: Set<string>;
}

/**
 * Auto-detect the base branch by finding the merge-base with origin/main.
 */
function detectBase(workspaceRoot: string): string | null {
    try {
        const mergeBase = execSync('git merge-base HEAD origin/main', {
            cwd: workspaceRoot,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        if (mergeBase) {
            return mergeBase;
        }
    } catch {
        try {
            const mergeBase = execSync('git merge-base HEAD main', {
                cwd: workspaceRoot,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();

            if (mergeBase) {
                return mergeBase;
            }
        } catch {
            // Ignore
        }
    }
    return null;
}

/**
 * Get changed files between base and head (or working tree if head not specified).
 */
// webpieces-disable max-lines-new-methods -- Git command handling with untracked files requires multiple code paths
function getChangedFiles(workspaceRoot: string, base: string, head?: string): string[] {
    try {
        const diffTarget = head ? `${base} ${head}` : base;
        const output = execSync(`git diff --name-only ${diffTarget}`, {
            cwd: workspaceRoot,
            encoding: 'utf-8',
        });
        const changedFiles = output
            .trim()
            .split('\n')
            .filter((f) => f.length > 0);

        if (!head) {
            try {
                const untrackedOutput = execSync('git ls-files --others --exclude-standard', {
                    cwd: workspaceRoot,
                    encoding: 'utf-8',
                });
                const untrackedFiles = untrackedOutput
                    .trim()
                    .split('\n')
                    .filter((f) => f.length > 0);
                const allFiles = new Set([...changedFiles, ...untrackedFiles]);
                return Array.from(allFiles);
            } catch {
                return changedFiles;
            }
        }

        return changedFiles;
    } catch {
        return [];
    }
}

/**
 * Get the diff content for a specific file.
 */
function getFileDiff(workspaceRoot: string, file: string, base: string, head?: string): string {
    try {
        const diffTarget = head ? `${base} ${head}` : base;
        const diff = execSync(`git diff ${diffTarget} -- "${file}"`, {
            cwd: workspaceRoot,
            encoding: 'utf-8',
        });

        if (!diff && !head) {
            const fullPath = path.join(workspaceRoot, file);
            if (fs.existsSync(fullPath)) {
                const isUntracked = execSync(`git ls-files --others --exclude-standard "${file}"`, {
                    cwd: workspaceRoot,
                    encoding: 'utf-8',
                }).trim();

                if (isUntracked) {
                    const content = fs.readFileSync(fullPath, 'utf-8');
                    const lines = content.split('\n');
                    return lines.map((line) => `+${line}`).join('\n');
                }
            }
        }

        return diff;
    } catch {
        return '';
    }
}

/**
 * Parse diff to extract changed line numbers (additions only - lines starting with +).
 */
function getChangedLineNumbers(diffContent: string): Set<number> {
    const changedLines = new Set<number>();
    const lines = diffContent.split('\n');
    let currentLine = 0;

    for (const line of lines) {
        const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
            currentLine = parseInt(hunkMatch[1], 10);
            continue;
        }

        if (line.startsWith('+') && !line.startsWith('+++')) {
            changedLines.add(currentLine);
            currentLine++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            // Deletions don't increment line number
        } else {
            currentLine++;
        }
    }

    return changedLines;
}

/**
 * Convert a snake_case string to camelCase.
 * e.g., "version_number" -> "versionNumber", "id" -> "id"
 */
function snakeToCamel(s: string): string {
    return s.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Parse schema.prisma to build a map of Dbo model name -> set of field names (camelCase).
 * Only models whose name ends with "Dbo" are included.
 * Field names are converted from snake_case to camelCase since Dto fields use camelCase.
 */
function parsePrismaSchema(schemaPath: string): Map<string, Set<string>> {
    const models = new Map<string, Set<string>>();

    if (!fs.existsSync(schemaPath)) {
        return models;
    }

    const content = fs.readFileSync(schemaPath, 'utf-8');
    const lines = content.split('\n');

    let currentModel: string | null = null;
    let currentFields: Set<string> | null = null;

    for (const line of lines) {
        const trimmed = line.trim();

        // Match model declaration: model XxxDbo {
        const modelMatch = trimmed.match(/^model\s+(\w+Dbo)\s*\{/);
        if (modelMatch) {
            currentModel = modelMatch[1];
            currentFields = new Set<string>();
            continue;
        }

        // End of model block
        if (currentModel && trimmed === '}') {
            models.set(currentModel, currentFields!);
            currentModel = null;
            currentFields = null;
            continue;
        }

        // Inside a model block - extract field names
        if (currentModel && currentFields) {
            // Skip empty lines, comments, and model-level attributes (@@)
            if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) {
                continue;
            }

            // Field name is the first word on the line, converted to camelCase
            const fieldMatch = trimmed.match(/^(\w+)\s/);
            if (fieldMatch) {
                currentFields.add(snakeToCamel(fieldMatch[1]));
            }
        }
    }

    return models;
}

/**
 * Check if a field has @deprecated in a comment above it (within 3 lines).
 */
function isFieldDeprecated(fileLines: string[], fieldLine: number): boolean {
    const start = Math.max(0, fieldLine - 4);
    for (let i = start; i <= fieldLine - 1; i++) {
        const line = fileLines[i]?.trim() ?? '';
        if (line.includes('@deprecated')) return true;
    }
    return false;
}

/**
 * Parse a TypeScript file to find Dto class/interface declarations and their fields.
 * Skips classes ending with "JoinDto" since they compose other Dtos.
 */
// webpieces-disable max-lines-new-methods -- AST traversal for both class and interface Dto detection with field extraction
function findDtosInFile(filePath: string, workspaceRoot: string): DtoInfo[] {
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];

    const content = fs.readFileSync(fullPath, 'utf-8');
    const fileLines = content.split('\n');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const dtos: DtoInfo[] = [];

    function visit(node: ts.Node): void {
        const isClass = ts.isClassDeclaration(node);
        const isInterface = ts.isInterfaceDeclaration(node);

        if ((isClass || isInterface) && node.name) {
            const name = node.name.text;

            // Must end with Dto but NOT with JoinDto
            if (name.endsWith('Dto') && !name.endsWith('JoinDto')) {
                const fields: DtoFieldInfo[] = [];
                const nodeStart = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
                const nodeEnd = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

                for (const member of node.members) {
                    if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
                        if (member.name && ts.isIdentifier(member.name)) {
                            const fieldName = member.name.text;
                            const startPos = member.getStart(sourceFile);
                            const pos = sourceFile.getLineAndCharacterOfPosition(startPos);
                            const line = pos.line + 1;
                            const deprecated = isFieldDeprecated(fileLines, line);

                            fields.push({ name: fieldName, line, deprecated });
                        }
                    }
                }

                dtos.push({
                    name,
                    file: filePath,
                    startLine: nodeStart.line + 1,
                    endLine: nodeEnd.line + 1,
                    fields,
                });
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return dtos;
}

/**
 * Extract the prefix from a Dto/Dbo name by removing the suffix.
 * e.g., "UserDto" -> "user", "UserDbo" -> "user"
 */
function extractPrefix(name: string, suffix: string): string {
    return name.slice(0, -suffix.length).toLowerCase();
}

/**
 * Find violations: Dto fields that don't exist in the corresponding Dbo.
 */
function findViolations(
    dtos: DtoInfo[],
    dboModels: Map<string, Set<string>>,
    disableAllowed: boolean
): DtoViolation[] {
    const violations: DtoViolation[] = [];

    // Build a lowercase prefix -> Dbo info map
    const dboByPrefix = new Map<string, DboEntry>();
    for (const [dboName, fields] of dboModels) {
        const prefix = extractPrefix(dboName, 'Dbo');
        dboByPrefix.set(prefix, { name: dboName, fields });
    }

    for (const dto of dtos) {
        const prefix = extractPrefix(dto.name, 'Dto');
        const dbo = dboByPrefix.get(prefix);

        if (!dbo) {
            // No matching Dbo found - skip (might be a Dto without a DB table)
            continue;
        }

        for (const field of dto.fields) {
            if (disableAllowed && field.deprecated) continue;

            if (!dbo.fields.has(field.name)) {
                violations.push({
                    file: dto.file,
                    line: field.line,
                    dtoName: dto.name,
                    fieldName: field.name,
                    dboName: dbo.name,
                    availableFields: Array.from(dbo.fields).sort(),
                });
            }
        }
    }

    return violations;
}

/**
 * Compute similarity between two strings using longest common subsequence ratio.
 * Returns a value between 0 and 1, where 1 is an exact match.
 */
function similarity(a: string, b: string): number {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    if (al === bl) return 1;

    const m = al.length;
    const n = bl.length;
    const prev = new Array<number>(n + 1).fill(0);
    const curr = new Array<number>(n + 1).fill(0);

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (al[i - 1] === bl[j - 1]) {
                curr[j] = prev[j - 1] + 1;
            } else {
                curr[j] = Math.max(prev[j], curr[j - 1]);
            }
        }
        for (let j = 0; j <= n; j++) {
            prev[j] = curr[j];
            curr[j] = 0;
        }
    }

    const lcsLen = prev[n];
    return (2 * lcsLen) / (m + n);
}

/**
 * Find the closest matching Dbo field for a given Dto field name.
 * Returns the best match or null if nothing scores above the threshold.
 */
function suggestClosestField(fieldName: string, availableFields: string[]): string | null {
    let bestMatch: string | null = null;
    let bestScore = 0.4; // minimum threshold

    for (const candidate of availableFields) {
        const score = similarity(fieldName, candidate);
        if (score > bestScore) {
            bestScore = score;
            bestMatch = candidate;
        }
    }

    return bestMatch;
}

/**
 * Report violations to console with prominent AI warning and rename suggestions.
 */
function reportViolations(violations: DtoViolation[]): void {
    console.error('');
    console.error('❌❌❌ DTO FIELD MISMATCH - AI AGENT: READ THIS CAREFULLY ❌❌❌');
    console.error('');
    console.error('🛑 DO NOT attempt find/replace or manual renaming. Instead:');
    console.error('   1. IDE rename is 10x faster than AI renaming PLUS 100% correct vs. AI\'s 80%');
    console.error('   2. Based on errors below, suggest renames to the user');
    console.error('   3. Ask the human to use IDE rename-refactoring (F2 / right-click → Rename Symbol)');
    console.error('');
    console.error('📚 Every non-deprecated field in a Dto must exist in the corresponding Dbo.');
    console.error('   Dbo can have extra fields (e.g., password) — Dto fields cannot be invented.');
    console.error('');
    console.error('   When needing fields from multiple tables (e.g., a join), use a XxxJoinDto that');
    console.error('   contains YYDto and ZZDto fields from the other tables instead of flattening.');
    console.error('   Fields marked @deprecated in the Dto are exempt from this check.');
    console.error('');

    for (const v of violations) {
        console.error(`  ❌ ${v.file}:${v.line}`);
        console.error(`     ${v.dtoName}.${v.fieldName} does not exist in ${v.dboName}`);

        const suggestion = suggestClosestField(v.fieldName, v.availableFields);
        if (suggestion) {
            console.error(`     💡 Suggested rename: ${v.fieldName} → ${suggestion}   (Use IDE rename on ${v.dtoName}.${v.fieldName})`);
        } else {
            const preview = v.availableFields.slice(0, 8).join(', ');
            const ellipsis = v.availableFields.length > 8 ? ', ...' : '';
            console.error(`     💡 No close match found. Available: ${preview}${ellipsis}`);
        }
    }
    console.error('');

    console.error('❌❌❌ AI AGENT: Suggest to the human which are the most likely renames needed and list them ❌❌❌');
    console.error('');
}

/**
 * Filter changed files to only TypeScript Dto source files within configured paths.
 */
function filterDtoFiles(changedFiles: string[], dtoSourcePaths: string[]): string[] {
    return changedFiles.filter((f) => {
        if (!f.endsWith('.ts') && !f.endsWith('.tsx')) return false;
        if (f.includes('.spec.ts') || f.includes('.test.ts')) return false;
        return dtoSourcePaths.some((srcPath) => f.startsWith(srcPath));
    });
}

/**
 * Collect all Dto definitions from the given files.
 */
function collectDtos(dtoFiles: string[], workspaceRoot: string): DtoInfo[] {
    const allDtos: DtoInfo[] = [];
    for (const file of dtoFiles) {
        const dtos = findDtosInFile(file, workspaceRoot);
        allDtos.push(...dtos);
    }
    return allDtos;
}

/**
 * Check if a Dto class overlaps with any changed lines in the diff.
 */
function isDtoTouched(dto: DtoInfo, changedLines: Set<number>): boolean {
    for (let line = dto.startLine; line <= dto.endLine; line++) {
        if (changedLines.has(line)) return true;
    }
    return false;
}

/**
 * Filter Dtos to only those that have changed lines in the diff (MODIFIED_CLASS mode).
 */
function filterTouchedDtos(
    dtos: DtoInfo[],
    workspaceRoot: string,
    base: string,
    head?: string
): DtoInfo[] {
    // Group dtos by file to avoid re-fetching diffs
    const byFile = new Map<string, DtoInfo[]>();
    for (const dto of dtos) {
        const list = byFile.get(dto.file) ?? [];
        list.push(dto);
        byFile.set(dto.file, list);
    }

    const touched: DtoInfo[] = [];
    for (const [file, fileDtos] of byFile) {
        const diff = getFileDiff(workspaceRoot, file, base, head);
        const changedLines = getChangedLineNumbers(diff);
        for (const dto of fileDtos) {
            if (isDtoTouched(dto, changedLines)) {
                touched.push(dto);
            }
        }
    }
    return touched;
}

/**
 * Resolve git base ref from env vars or auto-detection.
 */
function resolveBase(workspaceRoot: string): string | undefined {
    const envBase = process.env['NX_BASE'];
    if (envBase) return envBase;
    return detectBase(workspaceRoot) ?? undefined;
}

/**
 * Run the core validation after early-exit checks have passed.
 */
// webpieces-disable max-lines-new-methods -- Core validation orchestration with multiple early-exit checks
function validateDtoFiles(
    workspaceRoot: string,
    prismaSchemaPath: string,
    changedFiles: string[],
    dtoSourcePaths: string[],
    mode: ValidateDtosMode,
    disableAllowed: boolean,
    base: string,
    head?: string
): ExecutorResult {
    if (changedFiles.some((f) => f.endsWith(prismaSchemaPath))) {
        console.log('⏭️  Skipping validate-dtos (schema.prisma is modified - schema in flux)');
        console.log('');
        return { success: true };
    }

    const dtoFiles = filterDtoFiles(changedFiles, dtoSourcePaths);

    if (dtoFiles.length === 0) {
        console.log('✅ No Dto files changed');
        return { success: true };
    }

    console.log(`📂 Checking ${dtoFiles.length} changed file(s) for Dto definitions...`);

    const fullSchemaPath = path.join(workspaceRoot, prismaSchemaPath);
    const dboModels = parsePrismaSchema(fullSchemaPath);

    if (dboModels.size === 0) {
        console.log('⏭️  No Dbo models found in schema.prisma');
        console.log('');
        return { success: true };
    }

    console.log(`   Found ${dboModels.size} Dbo model(s) in schema.prisma`);

    let allDtos = collectDtos(dtoFiles, workspaceRoot);

    if (allDtos.length === 0) {
        console.log('✅ No Dto definitions found in changed files');
        return { success: true };
    }

    // In MODIFIED_CLASS mode, narrow to only Dtos with changed lines
    if (mode === 'MODIFIED_CLASS') {
        allDtos = filterTouchedDtos(allDtos, workspaceRoot, base, head);
        if (allDtos.length === 0) {
            console.log('✅ No Dto classes were modified');
            return { success: true };
        }
    }

    console.log(`   Validating ${allDtos.length} Dto definition(s)`);

    const violations = findViolations(allDtos, dboModels, disableAllowed);

    if (violations.length === 0) {
        console.log('✅ All Dto fields match their Dbo models');
        return { success: true };
    }

    reportViolations(violations);
    return { success: false };
}

/**
 * Resolve mode considering ignoreModifiedUntilEpoch override.
 * When active, downgrades to OFF. When expired, logs a warning.
 */
function resolveMode(normalMode: ValidateDtosMode, epoch: number | undefined): ValidateDtosMode {
    if (epoch === undefined || normalMode === 'OFF') {
        return normalMode;
    }
    const nowSeconds = Date.now() / 1000;
    if (nowSeconds < epoch) {
        const expiresDate = new Date(epoch * 1000).toISOString().split('T')[0];
        console.log(`\n⏭️  Skipping validate-dtos (ignoreModifiedUntilEpoch active, expires: ${expiresDate})`);
        console.log('');
        return 'OFF';
    }
    const expiresDate = new Date(epoch * 1000).toISOString().split('T')[0];
    console.log(`\n⚠️  validateDtos.ignoreModifiedUntilEpoch (${epoch}) has expired (${expiresDate}). Remove it from nx.json. Using normal mode: ${normalMode}\n`);
    return normalMode;
}

export default async function runExecutor(
    options: ValidateDtosOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const mode = resolveMode(options.mode ?? 'OFF', options.ignoreModifiedUntilEpoch);

    if (mode === 'OFF') {
        console.log('\n⏭️  Skipping validate-dtos (mode: OFF)');
        console.log('');
        return { success: true };
    }

    const prismaSchemaPath = options.prismaSchemaPath;
    const dtoSourcePaths = options.dtoSourcePaths ?? [];

    if (!prismaSchemaPath || dtoSourcePaths.length === 0) {
        const reason = !prismaSchemaPath ? 'no prismaSchemaPath configured' : 'no dtoSourcePaths configured';
        console.log(`\n⏭️  Skipping validate-dtos (${reason})`);
        console.log('');
        return { success: true };
    }

    console.log('\n📏 Validating DTOs match Prisma Dbo models\n');
    console.log(`   Mode: ${mode}`);
    console.log(`   Schema: ${prismaSchemaPath}`);
    console.log(`   Dto paths: ${dtoSourcePaths.join(', ')}`);

    const base = resolveBase(workspaceRoot);
    const head = process.env['NX_HEAD'];

    if (!base) {
        console.log('\n⏭️  Skipping validate-dtos (could not detect base branch)');
        console.log('');
        return { success: true };
    }

    console.log(`   Base: ${base}`);
    console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}`);
    console.log('');

    const disableAllowed = options.disableAllowed ?? true;
    const changedFiles = getChangedFiles(workspaceRoot, base, head);

    return validateDtoFiles(workspaceRoot, prismaSchemaPath, changedFiles, dtoSourcePaths, mode, disableAllowed, base, head);
}
