/**
 * The shared half of the api-library source rules: the two `role:api-lib` spelling rules (#1023),
 * `no-inline-import-in-api-lib` and `one-enum-spelling-in-api-lib`, and `no-utility-types-in-api-lib`
 * (#1026), which scopes itself by its configured `paths` globs instead of the role tag.
 *
 * Both judge the SOURCE of an api library — the contract every consumer and the OpenAPI / MCP
 * generator read — and both have the same rollout shape: `mode` NEW_AND_MODIFIED_CODE judges only the
 * changed lines (so existing code is grandfathered until someone touches it), NEW_AND_MODIFIED_FILES
 * judges every site in a changed file. This class owns that scoping, the api-lib test, the escape
 * hatches, and the ONE failure spelling: a thrown `RuleFailError` with one `Option` per site, which
 * `RuleReporter` renders. A subclass only says what a violating site IS.
 *
 * Parser-only on purpose (no `ts.Program`): each rule reads the syntax as written, which is exactly
 * what it refuses, and a parse cannot be diverted to a `.d.ts` by module resolution.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
    DiffScope,
    ModifiedCodeMode,
    NoInlineImportInApiLibConfig,
    NoUtilityTypesInApiLibConfig,
    OneEnumSpellingInApiLibConfig,
    Option,
    RuleFailError,
    hasDisable,
    isPathExcluded,
} from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { ProjectRoleResolver } from './project-role-resolver';

/** The role these rules judge. */
const API_LIB_ROLE = 'api-lib';

/** One violating site: where, what it is, and the edit that replaces it. Data-only. */
export class ApiLibSite {
    constructor(
        /** 1-based line of the site's first character. */
        readonly line: number,
        /** The offending source text, trimmed to one line. */
        readonly snippet: string,
        readonly what: string,
        readonly cure: string,
    ) {}
}

/** One api-library source file, parsed, with the project directory that owns it. Data-only. */
export class ApiLibFile {
    constructor(
        /** Workspace-relative. */
        readonly relFile: string,
        readonly source: ts.SourceFile,
        /** Absolute path of the owning project's directory (the one holding project.json). */
        readonly projectDir: string,
    ) {}

    /** The 1-based line a node starts on. */
    lineOf(node: ts.Node): number {
        return this.source.getLineAndCharacterOfPosition(node.getStart(this.source)).line + 1;
    }

    /** A site at `node`, its text collapsed to one line. */
    site(node: ts.Node, what: string, cure: string): ApiLibSite {
        const text = node.getText(this.source).replace(/\s+/g, ' ').trim();
        return new ApiLibSite(this.lineOf(node), text, what, cure);
    }
}

/** A located site, for the failure message. Data-only. */
class FoundSite {
    constructor(
        readonly relFile: string,
        readonly site: ApiLibSite,
    ) {}
}

type ApiLibConfig = NoInlineImportInApiLibConfig | OneEnumSpellingInApiLibConfig | NoUtilityTypesInApiLibConfig;

export abstract class ApiLibSourceRule<C extends ApiLibConfig> extends CodeValidator<C> {
    constructor(
        config: C,
        ruleName: string,
        private readonly roleResolver: ProjectRoleResolver,
        private readonly diffScope: DiffScope,
    ) {
        super(config, ruleName, ruleName);
    }

    /** Every violating site in one api-library file. */
    protected abstract sitesIn(file: ApiLibFile): ApiLibSite[];

    /** The one-sentence WHY printed above the sites. */
    protected abstract why(): string;

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        const mode: ModifiedCodeMode | undefined = this.config.mode;
        if (mode === undefined || mode === 'OFF') return { success: true };
        // NX_BASE / NX_HEAD when nx set them, else the merge-base with main.
        const range = this.diffScope.resolveBase(workspaceRoot);
        const base = range.base;
        if (base === undefined) {
            console.log(`\n⏭️  Skipping ${this.name} validation (could not detect base branch)\n`);
            return { success: true };
        }
        const found: FoundSite[] = [];
        for (const relFile of this.diffScope.getChangedFiles(workspaceRoot, base, range.head)) {
            found.push(...this.judge(workspaceRoot, relFile, mode, base, range.head));
        }
        if (found.length === 0) return { success: true };
        throw this.failure(found);
    }

    /** The unexempt, in-scope violating sites of one changed file. */
    private judge(
        workspaceRoot: string,
        relFile: string,
        mode: ModifiedCodeMode,
        base: string,
        head: string | undefined,
    ): FoundSite[] {
        if (!this.inScope(workspaceRoot, relFile)) return [];
        const changedLines = mode === 'NEW_AND_MODIFIED_CODE'
            ? this.diffScope.getChangedLineNumbers(this.diffScope.getFileDiff(workspaceRoot, relFile, base, head))
            : undefined;
        if (changedLines !== undefined && changedLines.size === 0) return [];
        const absFile = path.join(workspaceRoot, relFile);
        const text = fs.readFileSync(absFile, 'utf8');
        const lines = text.split('\n');
        const source = ts.createSourceFile(absFile, text, ts.ScriptTarget.Latest, true);
        const file = new ApiLibFile(relFile, source, this.projectDirOf(workspaceRoot, relFile));
        return this.sitesIn(file)
            .filter((site: ApiLibSite) => changedLines === undefined || changedLines.has(site.line))
            .filter((site: ApiLibSite) => !this.disabled(lines, site.line))
            .map((site: ApiLibSite) => new FoundSite(relFile, site));
    }

    /** A non-test `.ts` file, not under `allowedPaths`, that {@link isApiLibrarySource} claims. */
    private inScope(workspaceRoot: string, relFile: string): boolean {
        if (!relFile.endsWith('.ts') || relFile.endsWith('.d.ts')) return false;
        if (/\.(spec|test)\.ts$/.test(relFile) || relFile.includes('__tests__/')) return false;
        if (isPathExcluded(relFile, this.config.allowedPaths ?? [])) return false;
        if (!fs.existsSync(path.join(workspaceRoot, relFile))) return false;
        return this.isApiLibrarySource(workspaceRoot, relFile);
    }

    /** Is `relFile` part of an api library? By default: its owning project is tagged `role:api-lib`. */
    protected isApiLibrarySource(workspaceRoot: string, relFile: string): boolean {
        return this.roleResolver.roleOf(workspaceRoot, relFile) === API_LIB_ROLE;
    }

    /** How the failure names where the sites are — must agree with {@link isApiLibrarySource}. */
    protected scopeLabel(): string {
        return 'a role:api-lib project';
    }

    /** `// webpieces-disable <rule> -- <reason>` on the site's line or the line above. */
    private disabled(lines: readonly string[], line: number): boolean {
        return hasDisable(lines[line - 1] ?? '', this.name) || hasDisable(lines[line - 2] ?? '', this.name);
    }

    /** The nearest ancestor of `relFile` holding a project.json, absolute. */
    private projectDirOf(workspaceRoot: string, relFile: string): string {
        let dir = path.dirname(path.join(workspaceRoot, relFile));
        while (!fs.existsSync(path.join(dir, 'project.json')) && path.dirname(dir) !== dir) {
            dir = path.dirname(dir);
        }
        return dir;
    }

    private failure(found: readonly FoundSite[]): RuleFailError {
        const message =
            `${found.length} site(s) in ${this.scopeLabel()}: ${this.why()}\n` +
            found.map((each: FoundSite) => `  ${each.relFile}:${each.site.line} — ${each.site.what}\n      ${each.site.snippet}`).join('\n') +
            `\n  Last resort, per site: // webpieces-disable ${this.name} -- <reason>`;
        return new RuleFailError(
            this.name,
            message,
            undefined,
            undefined,
            found.map((each: FoundSite) => new Option(`${each.relFile}:${each.site.line}: ${each.site.cure}`, true)),
        );
    }
}
