/**
 * @webpieces/dev-config
 *
 * Development configuration, scripts, and patterns for WebPieces projects.
 *
 * This package provides:
 * - Nx inference plugin for architecture validation and circular dependency checking
 * - Executable scripts (via bin commands: wp-start, wp-stop, etc.)
 * - Shareable ESLint configuration
 * - Jest preset
 * - Base TypeScript configuration
 * - Claude Code pattern documentation
 *
 * @packageDocumentation
 */

import { createNodesV2 } from '../plugin';

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

/**
 * Default export for Nx plugin system
 * This is what Nx loads when the package is registered as a plugin in nx.json
 */
export default {
    name: '@webpieces/dev-config',
    createNodesV2,
};
