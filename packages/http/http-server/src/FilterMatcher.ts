import { Filter, WpResponse } from '@webpieces/http-filters';
import { MethodMeta } from './MethodMeta';
import { FilterDefinition } from '@webpieces/core-meta';
import { minimatch } from 'minimatch';

/**
 * Type alias for HTTP filters that work with MethodMeta and ResponseWrapper.
 */
export type HttpFilter = Filter<MethodMeta, WpResponse<unknown>>;

/**
 * FilterMatcher - Matches filters to routes based on filepath patterns.
 * Similar to Java SharedMatchUtil.findMatchingFilters().
 *
 * Responsibilities:
 * 1. Filter based on filepath glob pattern matching
 * 2. Sort matching filters by priority (higher first)
 *
 * Differences from Java:
 * - Uses glob patterns instead of regex
 * - Only matches filepaths (no URL path or HTTPS filtering yet)
 * - Simpler API focused on one responsibility
 */
export class FilterMatcher {
    /**
     * Find filters that match the given controller filepath.
     *
     * @param controllerFilepath - The filepath of the controller source file
     * @param allFilters - All registered filters with their definitions
     * @returns Array of matching filters, sorted by priority (highest first)
     */
    static findMatchingFilters(
        controllerFilepath: string | undefined,
        allFilters: Array<FilterDefinition>,
    ): HttpFilter[] {
        const matchingFilters: Array<{ filter: HttpFilter; priority: number }> = [];

        for (const definition of allFilters) {
            const pattern = definition.filepathPattern;
            const filter = definition.filter as HttpFilter;

            // Special case: '*' matches all controllers (global filter)
            if (pattern === '*') {
                matchingFilters.push({ filter, priority: definition.priority });
                continue;
            }

            // If no filepath available, only match wildcard patterns
            if (!controllerFilepath) {
                if (pattern === '**/*') {
                    matchingFilters.push({ filter, priority: definition.priority });
                }
                continue;
            }

            // Normalize filepath for consistent matching
            const normalizedPath = FilterMatcher.normalizeFilepath(controllerFilepath);

            // Match using minimatch
            if (minimatch(normalizedPath, pattern)) {
                matchingFilters.push({ filter, priority: definition.priority });
            }
        }

        // Sort by priority (highest first)
        matchingFilters.sort((a, b) => b.priority - a.priority);

        return matchingFilters.map((item) => item.filter);
    }

    /**
     * Normalize a controller filepath for consistent matching.
     * - Converts backslashes to forward slashes (Windows compatibility)
     * - Removes leading './'
     *
     * @param filepath - Raw filepath
     * @returns Normalized filepath
     */
    static normalizeFilepath(filepath: string): string {
        return filepath
            .replace(/\\/g, '/') // Windows backslashes to forward slashes
            .replace(/^\.\//, ''); // Remove leading './'
    }
}
