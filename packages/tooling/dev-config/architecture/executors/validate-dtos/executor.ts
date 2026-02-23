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
 * - MODIFIED_FILES: Validate Dto files that were modified in the diff
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
 * - Dto fields must be a subset of Dbo fields
 * - Extra Dbo fields are allowed (e.g., password)
 */

import type { ExecutorContext } from '@nx/devkit';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export type ValidateDtosMode = 'OFF' | 'MODIFIED_FILES';

export interface ValidateDtosOptions {
    mode?: ValidateDtosMode;
    prismaSchemaPath?: string;
    dtoSourcePaths?: string[];
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
 * Parse schema.prisma to build a map of Dbo model name -> set of field names.
 * Only models whose name ends with "Dbo" are included.
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

            // Field name is the first word on the line
            const fieldMatch = trimmed.match(/^(\w+)\s/);
            if (fieldMatch) {
                currentFields.add(fieldMatch[1]);
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

                dtos.push({ name, file: filePath, fields });
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
    dboModels: Map<string, Set<string>>
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
            if (field.deprecated) continue;

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
 * Report violations to console.
 */
function reportViolations(violations: DtoViolation[]): void {
    console.error('');
    console.error('❌ DTO fields don\'t match Prisma Dbo models!');
    console.error('');
    console.error('📚 Every non-deprecated field in a Dto must exist in the corresponding Dbo.');
    console.error('   This prevents AI from inventing field names that don\'t match the database schema.');
    console.error('   Dbo can have extra fields (e.g., password) - Dto cannot.');
    console.error('');

    for (const v of violations) {
        console.error(`  ❌ ${v.file}:${v.line}`);
        console.error(`     ${v.dtoName}.${v.fieldName} does not exist in ${v.dboName}`);
        console.error(`     Available Dbo fields: ${v.availableFields.join(', ')}`);
    }
    console.error('');

    console.error('   Dto fields must be a subset of Dbo fields (matching TypeScript field names from schema.prisma).');
    console.error('   Fields marked @deprecated in the Dto are exempt from this check.');
    console.error('');
    console.error('   When needing fields from multiple tables (e.g., a join), use a XxxJoinDto that');
    console.error('   contains YYDto and ZZDto fields from the other tables instead of flattening.');
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
function validateDtoFiles(
    workspaceRoot: string,
    prismaSchemaPath: string,
    changedFiles: string[],
    dtoSourcePaths: string[]
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

    const allDtos = collectDtos(dtoFiles, workspaceRoot);

    if (allDtos.length === 0) {
        console.log('✅ No Dto definitions found in changed files');
        return { success: true };
    }

    console.log(`   Found ${allDtos.length} Dto definition(s) in changed files`);

    const violations = findViolations(allDtos, dboModels);

    if (violations.length === 0) {
        console.log('✅ All Dto fields match their Dbo models');
        return { success: true };
    }

    reportViolations(violations);
    return { success: false };
}

export default async function runExecutor(
    options: ValidateDtosOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const mode: ValidateDtosMode = options.mode ?? 'OFF';

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

    const changedFiles = getChangedFiles(workspaceRoot, base, head);

    return validateDtoFiles(workspaceRoot, prismaSchemaPath, changedFiles, dtoSourcePaths);
}
