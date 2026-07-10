#!/usr/bin/env node
/**
 * wp-design-visualize — open per-project DI design graphs as Graphviz HTML.
 *
 * Usage:
 *   wp-design-visualize                    interactive picker (numbered list)
 *   wp-design-visualize <name|substring>…  render matching project(s)
 *   wp-design-visualize all                render every project
 *
 * Reads each project's committed design.json (schemaVersion 2 — one design
 * per controller/root) and writes tmp/webpieces/design-<project>.html with
 * one graph PER CONTROLLER, the controller (level 0) at the top. Replaces the
 * old mermaid-based scripts/design-visualize.sh (which only showed the first
 * controller).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { CliExitError, runMain } from '@webpieces/rules-config';
import { DesignFileRef, findDesignFiles, resolveSelections } from '../lib/di-graph/design-finder';
import { writeDesignVisualization } from '../lib/di-graph/design-visualizer';
import { GraphVisualizer } from '../lib/graph-visualizer';
import { DiGraph } from '../lib/di-graph/model';

/** Walk up from cwd to the workspace root (dir containing nx.json). */
function findWorkspaceRoot(): string {
    let dir = process.cwd();
    for (let i = 0; i < 20; i++) {
        if (fs.existsSync(path.join(dir, 'nx.json'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return process.cwd();
}

function printList(files: DesignFileRef[]): void {
    console.log('\nDI design graphs found:\n');
    files.forEach((file: DesignFileRef, index: number) => {
        console.log(`  ${String(index + 1).padStart(3)}. ${file.project.padEnd(24)} ${file.relPath}`);
    });
    console.log('');
}

/** Prompt for selections: numbers, names/substrings, or "all" (blank = cancel). */
function promptSelections(): Promise<string[]> {
    return new Promise((resolve: (selections: string[]) => void) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('Which designs? (numbers / names / all, blank to cancel): ', (answer: string) => {
            rl.close();
            resolve(answer.split(/[\s,]+/).filter((part: string) => part.length > 0));
        });
    });
}

function loadDiGraph(file: DesignFileRef): DiGraph {
    const parsed = JSON.parse(fs.readFileSync(file.absPath, 'utf-8'));
    if (!Array.isArray(parsed.designs)) {
        throw new Error(
            `${file.relPath} is an old-format design.json (schemaVersion ${parsed.schemaVersion ?? 1}). ` +
                `Regenerate it with: pnpm nx run ${file.project}:di-graph-generate`
        );
    }
    return parsed as DiGraph;
}

function renderOne(file: DesignFileRef, workspaceRoot: string): void {
    const graph = loadDiGraph(file);
    const paths = writeDesignVisualization(graph, workspaceRoot);
    const designCount = graph.designs.length;
    console.log(`✅ ${file.project}: ${designCount} design(s) → ${paths.htmlPath}`);
    if (!new GraphVisualizer().openVisualization(paths.htmlPath)) {
        console.log(`⚠️  Could not auto-open. Open manually: ${paths.htmlPath}`);
    }
}

async function main(): Promise<void> {
    const workspaceRoot = findWorkspaceRoot();
    const files = findDesignFiles(workspaceRoot);

    if (files.length === 0) {
        throw new CliExitError(1, '❌ No design.json files found. Run a build or: pnpm nx run-many --target=di-graph-generate');
    }

    let selections = process.argv.slice(2);
    if (selections.length === 0) {
        printList(files);
        selections = await promptSelections();
        if (selections.length === 0) {
            console.log('Cancelled.');
            return;
        }
    }

    const picked = resolveSelections(selections, files);
    for (const file of picked) {
        renderOne(file, workspaceRoot);
    }
}

if (require.main === module) runMain(main);
