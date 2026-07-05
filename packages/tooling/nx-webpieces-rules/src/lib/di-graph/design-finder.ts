/**
 * Design File Finder
 *
 * Locates committed <projectRoot>/design.json files across the workspace and
 * resolves user selections (names, substrings, numbers, 'all') against them.
 * Core logic of the wp-design-visualize CLI, kept here so it is unit-testable.
 */

import * as fs from 'fs';
import * as path from 'path';
import { toError } from '../../toError';

const SKIP_DIRS = new Set<string>(['node_modules', 'dist', '.git', '.nx', 'tmp', 'coverage']);

/**
 * One discovered design.json file.
 */
export class DesignFileRef {
    constructor(
        /** Project name from the design.json contents */
        public readonly project: string,
        /** Workspace-relative posix path to the design.json */
        public readonly relPath: string,
        /** Absolute path to the design.json */
        public readonly absPath: string
    ) {}
}

/**
 * Recursively find every design.json in the workspace (skipping build/vcs
 * dirs), sorted by project name.
 */
export function findDesignFiles(workspaceRoot: string): DesignFileRef[] {
    const refs: DesignFileRef[] = [];
    scanDir(workspaceRoot, workspaceRoot, refs);
    refs.sort((a: DesignFileRef, b: DesignFileRef) => a.project.localeCompare(b.project));
    return refs;
}

function scanDir(dir: string, workspaceRoot: string, refs: DesignFileRef[]): void {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
                scanDir(fullPath, workspaceRoot, refs);
            } else if (entry.name === 'design.json') {
                addRef(fullPath, workspaceRoot, refs);
            }
        }
    } catch (err: unknown) {
        const error = toError(err);
        void error; // unreadable dir — skip it
    }
}

function addRef(absPath: string, workspaceRoot: string, refs: DesignFileRef[]): void {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const parsed = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
        const relPath = path.relative(workspaceRoot, absPath).replace(/\\/g, '/');
        const project = typeof parsed.project === 'string' ? parsed.project : relPath;
        refs.push(new DesignFileRef(project, relPath, absPath));
    } catch (err: unknown) {
        const error = toError(err);
        console.warn(`⚠️  Skipping unparseable ${absPath}: ${error.message}`);
    }
}

/**
 * Resolve user selections against the discovered files.
 * Accepts: 'all', 1-based numbers, exact project names, or substrings of the
 * project name / path. Throws on a selection that matches nothing.
 */
export function resolveSelections(selections: string[], files: DesignFileRef[]): DesignFileRef[] {
    const picked = new Map<string, DesignFileRef>();

    for (const rawSelection of selections) {
        const selection = rawSelection.trim();
        if (selection.length === 0) continue;

        if (selection.toLowerCase() === 'all') {
            for (const file of files) picked.set(file.absPath, file);
            continue;
        }

        for (const file of matchSelection(selection, files)) {
            picked.set(file.absPath, file);
        }
    }

    return Array.from(picked.values());
}

function matchSelection(selection: string, files: DesignFileRef[]): DesignFileRef[] {
    const asNumber = Number(selection);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= files.length) {
        return [files[asNumber - 1]];
    }

    const exact = files.filter((file: DesignFileRef) => file.project === selection);
    if (exact.length > 0) return exact;

    const lower = selection.toLowerCase();
    const partial = files.filter(
        (file: DesignFileRef) =>
            file.project.toLowerCase().includes(lower) || file.relPath.toLowerCase().includes(lower)
    );
    if (partial.length === 0) {
        throw new Error(
            `No design.json matches '${selection}'. Known projects: ${files
                .map((file: DesignFileRef) => file.project)
                .join(', ')}`
        );
    }
    return partial;
}
