import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { DiffScope, hasDisable, RuleFileExclusions } from '@webpieces/rules-config';
import { ModifiedCodeMode } from '@webpieces/rules-sdk';

/** Suffix enforcement keeps its own rollout scope, independently of the enclosing doc rule. */
export class WireSuffixScope {
    private constructor(
        private readonly root: string,
        private readonly mode: ModifiedCodeMode,
        // required-type-suffix's framework-owned path exclusions (#1253): the repo's top-level
        // excludePaths plus the rule's own — the same RuleFileExclusions the code-rules runtime applies.
        private readonly exclusions: RuleFileExclusions,
        // null in RUN_EVERY_TIME: every file is in scope.
        private readonly changed: Set<string> | null,
        // NEW_AND_MODIFIED_CODE only: the changed lines of every changed TypeScript source file.
        private readonly lines: Map<string, Set<number>>,
    ) {}

    /**
     * Reads the diff ONCE, up front: the base, the changed files, and — in NEW_AND_MODIFIED_CODE — the
     * changed lines of every changed TypeScript source file (the only files {@link includes} can judge in
     * that mode), because the git reads are asynchronous and {@link includes} is not.
     */
    // webpieces-disable no-function-outside-class -- static async factory of this class
    static async create(
        root: string,
        mode: ModifiedCodeMode,
        exclusions: RuleFileExclusions,
        diff: DiffScope,
    ): Promise<WireSuffixScope> {
        const lines = new Map<string, Set<number>>();
        if (mode === 'RUN_EVERY_TIME') return new WireSuffixScope(root, mode, exclusions, null, lines);
        const range = await diff.resolveBase(root);
        if (range.base === undefined) return new WireSuffixScope(root, mode, exclusions, new Set<string>(), lines);
        const changed = new Set(await diff.getChangedFiles(root, range.base, range.head, { tsOnly: false }));
        if (mode === 'NEW_AND_MODIFIED_CODE') {
            for (const relFile of changed) {
                if (!WireSuffixScope.isJudgedSource(relFile)) continue;
                lines.set(relFile, diff.getChangedLineNumbers(
                    await diff.getFileDiff(root, relFile, range.base, range.head)));
            }
        }
        return new WireSuffixScope(root, mode, exclusions, changed, lines);
    }

    // A file includes() can judge at all: TypeScript source, not a declaration file or a test.
    // webpieces-disable no-function-outside-class -- static predicate shared by create() and includes()
    private static isJudgedSource(relFile: string): boolean {
        if (!/\.tsx?$/.test(relFile)) return false;
        return !(relFile.endsWith('.d.ts') || /\.(spec|test)\.ts$/.test(relFile) || relFile.includes('__tests__/'));
    }

    includes(
        name: string,
        relFile: string,
        projectRoot: string,
        location: string,
        projectRoots: readonly string[],
    ): boolean {
        if (this.mode === 'OFF' || this.exclusions.excludes(relFile)) return false;
        if (
            relFile.endsWith('.d.ts') ||
            /\.(spec|test)\.ts$/.test(relFile) ||
            relFile.includes('__tests__/')
        )
            return false;
        if (!this.fileInScope(relFile, projectRoot, projectRoots)) return false;
        const file = path.resolve(this.root, relFile);
        const text = fs.readFileSync(file, 'utf8');
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const declaredLine = Number(/:(\d+):\d+$/.exec(location)?.[1]);
        const declaration = this.declarationAt(source, name, declaredLine);
        if (declaration === undefined) return false;
        const named = declaration as
            | ts.ClassDeclaration
            | ts.InterfaceDeclaration
            | ts.EnumDeclaration
            | ts.TypeAliasDeclaration;
        const line = source.getLineAndCharacterOfPosition(named.name!.getStart(source)).line + 1;
        const textLines = text.split('\n');
        if (
            hasDisable(textLines[line - 1] ?? '', 'required-type-suffix') ||
            hasDisable(textLines[line - 2] ?? '', 'required-type-suffix')
        )
            return false;
        return this.mode !== 'NEW_AND_MODIFIED_CODE' || this.changedLines(relFile).has(line);
    }

    private declarationAt(
        source: ts.SourceFile,
        name: string,
        line: number,
    ): ts.DeclarationStatement | undefined {
        let found: ts.DeclarationStatement | undefined;
        const visit = (node: ts.Node): void => {
            if (
                (ts.isClassDeclaration(node) ||
                    ts.isInterfaceDeclaration(node) ||
                    ts.isEnumDeclaration(node) ||
                    ts.isTypeAliasDeclaration(node)) &&
                node.name?.text === name &&
                source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 === line
            )
                found = node;
            if (found === undefined) ts.forEachChild(node, visit);
        };
        visit(source);
        return found;
    }

    private fileInScope(
        relFile: string,
        projectRoot: string,
        projectRoots: readonly string[],
    ): boolean {
        if (this.changed === null) return true;
        if (this.mode !== 'MODIFIED_PROJECTS') return this.changed.has(relFile);
        return [...this.changed].some((file: string) => {
            const owner = projectRoots
                .filter((root: string) => file === root || file.startsWith(`${root}/`))
                .sort((a: string, b: string) => b.length - a.length)[0];
            return owner === projectRoot;
        });
    }

    private changedLines(relFile: string): ReadonlySet<number> {
        return this.lines.get(relFile) ?? new Set<number>();
    }
}
