import type { ExecutorContext } from '@nx/devkit';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

export interface ValidateEslintSyncOptions {}

function calculateHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
}

function normalizeContent(content: string): string {
    // Normalize line endings and trim whitespace
    return content.replace(/\r\n/g, '\n').trim();
}

export default async function validateEslintSyncExecutor(
    options: ValidateEslintSyncOptions,
    context: ExecutorContext
): Promise<{ success: boolean }> {
    const workspaceRoot = context.root;

    const templatePath = join(workspaceRoot, 'packages/tooling/dev-config/templates/eslint.webpieces.config.mjs');
    const workspacePath = join(workspaceRoot, 'eslint.webpieces.config.mjs');

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const templateContent = readFileSync(templatePath, 'utf-8');
        const workspaceContent = readFileSync(workspacePath, 'utf-8');

        const templateRules = extractRulesSection(templateContent);
        const workspaceRules = extractRulesSection(workspaceContent);

        const templateHash = calculateHash(normalizeContent(templateRules));
        const workspaceHash = calculateHash(normalizeContent(workspaceRules));

        if (templateHash !== workspaceHash) {
            printValidationError(templatePath, workspacePath);
            return { success: false };
        }

        console.log('✅ ESLint configuration sync validated - rules match!');
        return { success: true };

    } catch (err: any) {
        // Error occurred during validation - log and fail
        // eslint-disable-next-line @webpieces/catch-error-pattern
        console.error('❌ Error validating ESLint sync:', err);
        return { success: false };
    }
}

function printValidationError(templatePath: string, workspacePath: string): void {
    console.error('');
    console.error('❌ ESLint configuration sync validation FAILED');
    console.error('');
    console.error('The @webpieces ESLint rules must be identical in both files:');
    console.error(`  1. ${templatePath}`);
    console.error(`  2. ${workspacePath}`);
    console.error('');
    console.error('These files must have identical rules sections so that:');
    console.error('  - External clients get the same rules we use internally');
    console.error('  - We "eat our own dog food" - same rules for everyone');
    console.error('');
    console.error('To fix:');
    console.error('  1. Modify the rules in ONE file (recommend: templates/eslint.webpieces.config.mjs)');
    console.error('  2. Copy the rules section to the other file');
    console.error('  3. Keep import statements different (template uses npm, workspace uses loadWorkspaceRules)');
    console.error('');
    console.error('Customization for webpieces workspace goes in: eslint.config.mjs');
    console.error('');
}

function extractRulesSection(content: string): string {
    // Extract everything between "export default [" and the final "];"
    // This includes the rules configuration
    const match = content.match(/export default \[([\s\S]*)\];/);
    if (!match) {
        throw new Error('Could not extract rules section - export default not found');
    }

    return match[1].trim();
}
