/**
 * @webpieces/dev-config
 *
 * Development configuration, scripts, and patterns for WebPieces projects.
 *
 * This package provides:
 * - Executable scripts (via bin commands: wp-start, wp-stop, etc.)
 * - Shareable ESLint configuration
 * - Jest preset
 * - Base TypeScript configuration
 * - Claude Code pattern documentation
 *
 * @packageDocumentation
 */

/**
 * This is primarily a configuration and scripts package.
 * The actual exports are defined in package.json:
 *
 * - bin: Executable scripts (wp-start, wp-stop, etc.)
 * - exports: Configuration files (eslint, jest, tsconfig)
 *
 * See README.md for usage instructions.
 */

export const version = '0.0.0-dev';
export const packageName = '@webpieces/dev-config';

/**
 * Check if running in webpieces-ts workspace
 */
export function isWebpiecesWorkspace(): boolean {
    return process.cwd().includes('webpieces-ts');
}

/**
 * Get project root directory
 */
export function getProjectRoot(): string {
    // This is a simple helper, actual path detection is in bash scripts
    return process.cwd();
}
