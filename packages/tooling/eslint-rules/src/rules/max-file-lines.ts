/**
 * ESLint rule to enforce maximum file length
 *
 * Enforces a configurable maximum line count for files.
 * Default: 700 lines
 *
 * Configuration:
 * '@webpieces/max-file-lines': ['error', { max: 700 }]
 */

import type { Rule } from 'eslint';
import * as fs from 'fs';
import * as path from 'path';
import { writeTemplateIfMissing } from '@webpieces/rules-config';
import { toError } from '../toError';

interface FileLinesOptions {
    max: number;
}

// Module-level flag to prevent redundant file creation
let fileDocCreated = false;

function getWorkspaceRoot(context: Rule.RuleContext): string {
    const filename = context.filename || context.getFilename();
    let dir = path.dirname(filename);

    // Walk up directory tree to find workspace root
    while (dir !== path.dirname(dir)) {
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                if (pkg.workspaces || pkg.name === 'webpieces-ts') {
                    return dir;
                }
            } catch (err: unknown) {
                //const error = toError(err);
                void err; // Continue searching if JSON parse fails
            }
        }
        dir = path.dirname(dir);
    }
    return process.cwd(); // Fallback
}

function ensureFileDoc(context: Rule.RuleContext): void {
    if (fileDocCreated) return;
    const workspaceRoot = getWorkspaceRoot(context);
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        writeTemplateIfMissing(workspaceRoot, 'webpieces.filesize.md');
        fileDocCreated = true;
    } catch (err: unknown) {
        const error = toError(err);
        console.warn('[webpieces] Could not write webpieces.filesize.md', error);
    }
}

const rule: Rule.RuleModule = {
    meta: {
        type: 'suggestion',
        docs: {
            description: 'Enforce maximum file length',
            category: 'Best Practices',
            recommended: false,
            url: 'https://github.com/deanhiller/webpieces-ts',
        },
        messages: {
            tooLong:
                'AI Agent: READ .webpieces/instruct-ai/webpieces.filesize.md for fix instructions. File has {{actual}} lines (max: {{max}})',
        },
        fixable: undefined,
        schema: [
            {
                type: 'object',
                properties: {
                    max: {
                        type: 'integer',
                        minimum: 1,
                    },
                },
                additionalProperties: false,
            },
        ],
    },

    create(context: Rule.RuleContext): Rule.RuleListener {
        const options = context.options[0] as FileLinesOptions | undefined;
        const maxLines = options?.max ?? 700;

        return {
            // webpieces-disable no-any-unknown -- ESTree AST nodes require any for dynamic properties
            Program(node: any): void {
                ensureFileDoc(context);

                const sourceCode = context.sourceCode || context.getSourceCode();
                const lines = sourceCode.lines;
                const lineCount = lines.length;

                if (lineCount > maxLines) {
                    context.report({
                        node,
                        messageId: 'tooLong',
                        data: {
                            actual: String(lineCount),
                            max: String(maxLines),
                        },
                    });
                }
            },
        };
    },
};

export = rule;
