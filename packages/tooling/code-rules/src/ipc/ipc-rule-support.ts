/**
 * What the four IPC validators share (#1389): the file listing, the MODIFIED_PROJECTS trigger of the two
 * project-scoped rules, and the ONE failure spelling (a thrown `RuleFailError`, one `Option` per site,
 * which `RuleReporter` renders).
 */

import { DiffScope, Option, RuleFailError, matchesAnyGlob } from '@webpieces/rules-config';
import { InformAiError } from '@webpieces/tooling-common';
import { IpcProjectMode } from '../configs/ipc-configs';
import { ProjectCatalog, ProjectEntry } from '../scan-scope';
import { IpcFinding } from './ipc-source';

/** A test or test-support file is never production IPC code, whatever the listing says. */
const TEST_FILE = /\.(spec|test)(?:-support)?\.[cm]?[jt]sx?$|(^|\/)__tests__\//;

export class IpcRuleSupport {
    constructor(
        private readonly diffScope: DiffScope,
        private readonly catalog: ProjectCatalog,
    ) {}

    /** True for a production TypeScript source file an IPC rule may judge. */
    isProductionSource(relFile: string): boolean {
        if (!/\.tsx?$/.test(relFile) || relFile.endsWith('.d.ts')) return false;
        return !TEST_FILE.test(relFile);
    }

    /** Every production TypeScript file in the workspace (names only — git's listing, nothing parsed). */
    async sourceFiles(workspaceRoot: string): Promise<string[]> {
        const all = await this.diffScope.getAllFiles(workspaceRoot);
        return all.filter((rel: string) => this.isProductionSource(rel));
    }

    /** The production TypeScript files matching `globs`, sorted by path. */
    async sourceFilesMatching(workspaceRoot: string, globs: readonly string[]): Promise<string[]> {
        return (await this.sourceFiles(workspaceRoot)).filter((rel: string) => matchesAnyGlob(rel, globs)).sort();
    }

    /**
     * Whether a project-scoped IPC rule runs: always under RUN_EVERY_TIME; under MODIFIED_PROJECTS when the
     * diff touches a file matching `globs` or any project that owns one.
     */
    async triggered(workspaceRoot: string, mode: IpcProjectMode, ruleName: string, globs: readonly string[]): Promise<boolean> {
        if (mode === 'RUN_EVERY_TIME') return true;
        const range = await this.diffScope.resolveBase(workspaceRoot);
        if (range.base === undefined) {
            throw new InformAiError(
                `${ruleName} could not determine the comparison base for MODIFIED_PROJECTS. Set NX_BASE to the ` +
                    'base branch or commit and retry.',
            );
        }
        const changed = await this.diffScope.getChangedFiles(workspaceRoot, range.base, range.head, { tsOnly: false });
        if (changed.some((rel: string) => matchesAnyGlob(rel, globs))) return true;
        const touched = new Set<string>();
        for (const rel of changed) {
            const owner = await this.catalog.ownerOf(workspaceRoot, rel);
            if (owner !== undefined && owner.dir !== '') touched.add(owner.dir);
        }
        if (touched.size === 0) return false;
        const listed = await this.diffScope.getAllFiles(workspaceRoot, { tsOnly: false });
        for (const rel of listed) {
            if (!matchesAnyGlob(rel, globs)) continue;
            const owner: ProjectEntry | undefined = await this.catalog.ownerOf(workspaceRoot, rel);
            if (owner !== undefined && touched.has(owner.dir)) return true;
        }
        return false;
    }

    /** The one failure: every finding as `file:line — message`, plus one fix option per site. */
    failure(ruleName: string, why: string, findings: readonly IpcFinding[]): RuleFailError {
        const lines = findings.map((each: IpcFinding) =>
            `  ${each.relFile}:${each.line} — ${each.message}${each.snippet ? `\n      ${each.snippet}` : ''}`);
        const message = `${findings.length} IPC site(s) refused by ${ruleName}: ${why}\n${lines.join('\n')}`;
        return new RuleFailError(
            ruleName,
            message,
            undefined,
            undefined,
            findings.map((each: IpcFinding) => new Option(`${each.relFile}:${each.line}: ${each.message}`, true)),
        );
    }
}
