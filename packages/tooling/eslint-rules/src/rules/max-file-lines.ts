/**
 * ESLint rule to enforce maximum file length
 *
 * Enforces a configurable maximum line count for files.
 * Default: 700 lines
 *
 * Configuration:
 * '@webpieces/max-file-lines': ['error', { max: 700, allowedPaths: ['vendor-glob-here'] }]
 *
 * Machine-generated trees (the GENERATED_CODE_PATHS list in @webpieces/rules-config: __generated__
 * and generated directories at any depth, .generated.ts / .generated.tsx files, and dist) are exempt
 * with NO configuration, and `allowedPaths` ADDS your own un-authored trees to that floor — the same
 * exemption the edit-time hook and the build-time validator apply, so one engine cannot pass a file
 * the next one blocks. Never list hand-written code there; a long file you wrote gets refactored.
 */

import type { Rule } from 'eslint';
import * as path from 'path';
import { writeTemplateIfMissing, isPathExcluded, GENERATED_CODE_PATHS } from '@webpieces/rules-config';
import { toError } from '../toError';
import { EslintWorkspaceRoot } from '../workspace-root';

const INSTRUCT_FILE = 'webpieces.filesize.md';
const workspace = new EslintWorkspaceRoot();

interface FileLinesOptions {
    max: number;
    allowedPaths?: string[];
}

// Module-level flag to prevent redundant file creation
let fileDocCreated = false;

function ensureFileDoc(context: Rule.RuleContext): void {
    if (fileDocCreated) return;
    const workspaceRoot = workspace.workspaceRoot(context);
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        writeTemplateIfMissing(workspaceRoot, INSTRUCT_FILE);
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
                'AI Agent: READ .webpieces/instruct-ai/webpieces.filesize.md (at the repo root) for fix instructions. File has {{actual}} lines (max: {{max}})',
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
                    allowedPaths: {
                        type: 'array',
                        items: { type: 'string' },
                    },
                },
                additionalProperties: false,
            },
        ],
    },

    create(context: Rule.RuleContext): Rule.RuleListener {
        const options = context.options[0] as FileLinesOptions | undefined;
        const maxLines = options?.max ?? 700;

        // Machine-generated trees are exempt with no configuration, exactly as they are in the
        // edit-time hook and the build-time validator — an exemption honoured by one engine and
        // ignored by another is the same file passing here and blocking there. `allowedPaths` adds
        // to that floor; it is for files this repo did not author, never for hand-written code.
        const filename = context.filename || context.getFilename();
        const relPath = path.relative(workspace.workspaceRoot(context), filename);
        // Normally the workspace-relative path is what the globs are written against. When root
        // resolution degenerates (no repo root above the file, or the file sits outside it) that path
        // is a bare basename or a `../` climb and would hide a `**/__generated__/**` match, so the
        // absolute path is judged instead — never in addition, so a repo checked out under a directory
        // named `dist` or `generated` is not exempted wholesale.
        const rooted = relPath !== '' && !relPath.startsWith('..') && relPath.includes(path.sep);
        const judged = rooted ? relPath : filename;
        if (isPathExcluded(judged, [...GENERATED_CODE_PATHS, ...(options?.allowedPaths ?? [])])) return {};

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
