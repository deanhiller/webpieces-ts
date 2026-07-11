import type { Rule } from 'eslint';
import * as path from 'path';
import { RepoRootFinder } from '@webpieces/rules-config';

/**
 * Repo-root + instruct-ai path resolution for ESLint rule modules.
 *
 * ESLint instantiates rule modules itself (not our DI container), so this is a thin holder around the
 * shared {@link RepoRootFinder}. It replaces the old per-rule heuristic (walk up for a package.json
 * with a `workspaces` field or the hardcoded name `webpieces-ts`, else `process.cwd()`), which
 * mis-resolved in nested packages and downstream repos and wrote stray `.webpieces` trees into
 * subdirectories.
 */
export class EslintWorkspaceRoot {
    private readonly finder = new RepoRootFinder();

    /** The repo root that owns `.webpieces/`, resolved from the file ESLint is linting. */
    workspaceRoot(context: Rule.RuleContext): string {
        const filename = context.filename || context.getFilename();
        return this.finder.resolveRepoRoot(path.dirname(filename));
    }

    /**
     * Absolute path to an instruct-ai doc for the repo ESLint is linting. Use in a rule message so the
     * AI is handed the exact file to open — a bare `.webpieces/instruct-ai/...` relative path breaks
     * when the AI's cwd is a subdirectory.
     */
    docPath(context: Rule.RuleContext, docName: string): string {
        return this.finder.instructAiDocPath(this.workspaceRoot(context), docName);
    }
}
