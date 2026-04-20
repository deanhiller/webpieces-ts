/**
 * ESLint rule to discourage try-catch blocks outside test files
 *
 * Works alongside catch-error-pattern rule:
 * - catch-error-pattern: Enforces HOW to handle exceptions (with toError())
 * - no-unmanaged-exceptions: Enforces WHERE try-catch is allowed (tests only by default)
 *
 * Philosophy: Exceptions should bubble to global error handlers where they are logged
 * with traceId and stored for debugging via /debugLocal and /debugCloud endpoints.
 * Local try-catch blocks break this architecture and create blind spots in production.
 *
 * Auto-allowed in:
 * - Test files (.test.ts, .spec.ts, __tests__/)
 *
 * Requires eslint-disable comment in:
 * - Retry loops with exponential backoff
 * - Batch processing where partial failure is expected
 * - Resource cleanup (with approval)
 */

import type { Rule } from 'eslint';
import * as fs from 'fs';
import * as path from 'path';
import { writeTemplateIfMissing } from '@webpieces/rules-config';
import { toError } from '../toError';

// webpieces-disable no-any-unknown -- ESTree AST node interface
interface TryStatementNode {
    handler?: unknown;
}

/**
 * Determines if a file is a test file based on naming conventions
 * Test files are auto-allowed to use try-catch blocks
 */
function isTestFile(filename: string): boolean {
    const normalizedPath = filename.toLowerCase();

    // Check file extensions
    if (normalizedPath.endsWith('.test.ts') || normalizedPath.endsWith('.spec.ts')) {
        return true;
    }

    // Check directory names (cross-platform)
    if (normalizedPath.includes('/__tests__/') || normalizedPath.includes('\\__tests__\\')) {
        return true;
    }

    return false;
}

/**
 * Finds the workspace root by walking up the directory tree
 * Looks for package.json with workspaces or name === 'webpieces-ts'
 */
function getWorkspaceRoot(context: Rule.RuleContext): string {
    const filename = context.filename || context.getFilename();
    let dir = path.dirname(filename);

    // Walk up directory tree
    for (let i = 0; i < 10; i++) {
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                // Check if this is the root workspace
                if (pkg.workspaces || pkg.name === 'webpieces-ts') {
                    return dir;
                }
            } catch (err: unknown) {
                //const error = toError(err);
                void err; // Invalid JSON, keep searching
            }
        }

        const parentDir = path.dirname(dir);
        if (parentDir === dir) break; // Reached filesystem root
        dir = parentDir;
    }

    // Fallback: return current directory
    return process.cwd();
}

/**
 * Ensures the exception documentation markdown file exists at
 * .webpieces/instruct-ai/webpieces.exceptions.md. Sourced from @webpieces/rules-config.
 */
function ensureExceptionDoc(context: Rule.RuleContext): void {
    if (exceptionDocCreated) return;
    const workspaceRoot = getWorkspaceRoot(context);
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        writeTemplateIfMissing(workspaceRoot, 'webpieces.exceptions.md');
        exceptionDocCreated = true;
    } catch (err: unknown) {
        void err;
    }
}

// Module-level flag to prevent redundant markdown file creation
let exceptionDocCreated = false;

// NOTE: Documentation content moved to templates/webpieces.exceptions.md
// The ensureExceptionDoc function reads from that file at runtime.

const rule: Rule.RuleModule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Discourage try-catch blocks outside test files - use global error handlers',
            category: 'Best Practices',
            recommended: true,
            url: 'https://github.com/deanhiller/webpieces-ts/blob/main/CLAUDE.md#exception-handling-philosophy',
        },
        messages: {
            noUnmanagedExceptions:
                'AI Agent: READ .webpieces/instruct-ai/webpieces.exceptions.md for context. Try-catch blocks are discouraged - use global error handlers instead. Only allowed in test files or with eslint-disable comment.',
        },
        fixable: undefined,
        schema: [],
    },

    create(context: Rule.RuleContext): Rule.RuleListener {
        return {
            // webpieces-disable no-any-unknown -- ESLint visitor callback parameter type
            TryStatement(node: unknown): void {
                // Skip try..finally blocks (no catch handler, no exception handling)
                // webpieces-disable no-any-unknown -- ESTree AST node type assertion
                if (!(node as TryStatementNode).handler) {
                    return;
                }

                // Auto-allow in test files
                const filename = context.filename || context.getFilename();
                if (isTestFile(filename)) {
                    return;
                }

                // Has catch block outside test file - report violation
                ensureExceptionDoc(context);
                context.report({
                    node: node as Rule.Node,
                    messageId: 'noUnmanagedExceptions',
                });
            },
        };
    },
};

export = rule;

