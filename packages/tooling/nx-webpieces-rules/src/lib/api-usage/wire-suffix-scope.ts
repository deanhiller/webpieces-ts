import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { DiffScope, hasDisable, RuleFileExclusions } from '@webpieces/rules-config';
import { ModifiedCodeMode } from '@webpieces/rules-sdk';

/** Suffix enforcement keeps its own rollout scope, independently of the enclosing doc rule. */
export class WireSuffixScope {
    private readonly changed: Set<string> | null;
    private readonly lines = new Map<string, Set<number>>();
    private readonly base: string | undefined;
    private readonly head: string | undefined;

    constructor(
        private readonly root: string,
        private readonly mode: ModifiedCodeMode,
        // required-type-suffix's framework-owned path exclusions (#1253): the repo's top-level
        // excludePaths plus the rule's own — the same RuleFileExclusions the code-rules runtime applies.
        private readonly exclusions: RuleFileExclusions,
        private readonly diff: DiffScope,
    ) {
        const range = mode === 'RUN_EVERY_TIME' ? undefined : diff.resolveBase(root);
        this.base = range?.base;
        this.head = range?.head;
        this.changed =
            mode === 'RUN_EVERY_TIME'
                ? null
                : new Set(
                      this.base === undefined
                          ? []
                          : diff.getChangedFiles(root, this.base, this.head, { tsOnly: false }),
                  );
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
        let lines = this.lines.get(relFile);
        if (lines === undefined) {
            lines =
                this.base === undefined
                    ? new Set<number>()
                    : this.diff.getChangedLineNumbers(
                          this.diff.getFileDiff(this.root, relFile, this.base, this.head),
                      );
            this.lines.set(relFile, lines);
        }
        return lines;
    }
}
