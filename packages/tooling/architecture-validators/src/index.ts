/**
 * Architecture Validation Module
 *
 * Provides tools for validating and managing the architecture dependency graph.
 *
 * Exports:
 * - Graph generation from project.json files
 * - Topological sorting and cycle detection
 * - Package.json validation
 * - Graph comparison
 * - Graph file loading/saving
 * - Graph visualization (DOT + HTML)
 */

export * from './lib/graph-generator';
export * from './lib/graph-sorter';
export * from './lib/graph-comparator';
export * from './lib/package-validator';
export * from './lib/graph-loader';
export * from './lib/graph-visualizer';
