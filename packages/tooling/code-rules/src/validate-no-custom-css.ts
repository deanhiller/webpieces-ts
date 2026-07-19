/**
 * Validate No Custom CSS Executor
 *
 * Enforces Tailwind-first styling in Angular sources by banning hand-written CSS on CHANGED code:
 *   - `.ts`   — `styles:` / `styleUrls:` / `styleUrl:` inside an `@Component({...})` decorator
 *               (detected via the TypeScript AST, so only the real decorator triggers it).
 *   - `.html` — a static `style="…"` attribute, a `[style]` / `[style.x]` binding, or `[ngStyle]`
 *               (line/regex scan — Angular templates have no TS AST).
 *
 * Unlike an ESLint rule (which lints whole files), this is diff-scoped: NEW_AND_MODIFIED_CODE only
 * flags violations on changed lines, so a legacy Angular app is never retroactively flooded — the
 * rule bites when a file is next edited.
 *
 * MODES: OFF | NEW_AND_MODIFIED_CODE (changed lines) | NEW_AND_MODIFIED_FILES (all in changed files).
 *
 * ESCAPE HATCH (a genuinely dynamic runtime value):
 *   .ts:   // webpieces-disable no-custom-css -- <reason>
 *   .html: <!-- webpieces-disable no-custom-css -- <reason> -->
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
    hasDisable,
    RULE_NAMES,
    NoCustomCssConfig,
    ModifiedCodeMode,
    detectBase,
    getChangedFiles,
    getFileDiff,
    getChangedLineNumbers,
} from '@webpieces/rules-config';
import { CodeValidator, ExecutorResult } from './code-validator';
import { injectable, bindingScopeValues } from 'inversify';
import { shouldSkipRule } from './resolve-mode';

// @Component decorator properties that inject hand-written CSS.
const STYLE_PROPS = new Set(['styles', 'styleUrls', 'styleUrl']);
const TEST_PATHS: RegExp[] = [/\.test\.ts$/, /\.spec\.ts$/, /__tests__\//];

// Template patterns. `[style.width]="x"` is preceded by `[`, so the inline-style regex's
// `(^|\s)style=` boundary keeps it apart from the binding forms.
const RE_INLINE_STYLE = /(^|\s)style\s*=\s*["']/;
const RE_NG_STYLE = /\[?ngStyle\]?\s*=/;
const RE_STYLE_BINDING = /\[style(?:\.[\w.-]+)?\]/;

export class CssViolation {
    constructor(
        readonly file: string,
        readonly line: number,
        readonly column: number,
        readonly detail: string,
    ) {}
}

export class CssHit {
    constructor(
        readonly line: number,
        readonly column: number,
        readonly detail: string,
        readonly hasDisableComment: boolean,
    ) {}
}

@injectable(bindingScopeValues.Singleton)
export class NoCustomCssValidator extends CodeValidator<NoCustomCssConfig> {
    constructor(config: NoCustomCssConfig) {
        super(config, 'no-custom-css');
    }

    async run(workspaceRoot: string): Promise<ExecutorResult> {
        const opts = this.config;
        const mode = this.resolveMode(opts.mode ?? 'OFF', opts.ignoreModifiedUntilEpoch, opts.ignoreRuleWhileOnBranch);
        const disableAllowed = opts.disableAllowed ?? true;
        if (mode === 'OFF') {
            console.log('\n⏭️  Skipping no-custom-css validation (mode: OFF)\n');
            return { success: true };
        }

        console.log('\n📏 Validating No Custom CSS (Tailwind-first)\n');
        console.log(`   Mode: ${mode}`);

        let base = process.env['NX_BASE'];
        const head = process.env['NX_HEAD'];
        if (!base) {
            base = detectBase(workspaceRoot) ?? undefined;
            if (!base) {
                console.log('\n⏭️  Skipping no-custom-css validation (could not detect base branch)\n');
                return { success: true };
            }
        }
        console.log(`   Base: ${base}`);
        console.log(`   Head: ${head ?? 'working tree (includes uncommitted changes)'}\n`);

        // tsOnly:false so changed .html templates are included; then filter to relevant files.
        const changedFiles = getChangedFiles(workspaceRoot, base, head, { tsOnly: false }).filter((f: string) => this.isRelevantFile(f));
        if (changedFiles.length === 0) {
            console.log('✅ No Angular .ts/.html files changed');
            return { success: true };
        }
        console.log(`📂 Checking ${changedFiles.length} changed file(s)...`);

        const violations =
            mode === 'NEW_AND_MODIFIED_CODE'
                ? this.findViolationsForModifiedCode(workspaceRoot, changedFiles, base, head, disableAllowed)
                : this.findViolationsForModifiedFiles(workspaceRoot, changedFiles, disableAllowed);

        if (violations.length === 0) {
            console.log('✅ No custom CSS found');
            return { success: true };
        }
        this.reportViolations(violations, mode);
        return { success: false };
    }

    /** A changed file this rule cares about: an Angular .ts/.tsx or .html, excluding test files. */
    isRelevantFile(file: string): boolean {
        if (TEST_PATHS.some((re: RegExp) => re.test(file))) return false;
        return file.endsWith('.html') || file.endsWith('.ts') || file.endsWith('.tsx');
    }

    /** All banned-CSS hits in a single file (dispatches to the .ts AST or the .html line scan). */
    findHitsForFile(file: string, workspaceRoot: string): CssHit[] {
        if (file.endsWith('.html')) return this.findCustomCssInHtmlFile(file, workspaceRoot);
        if (file.endsWith('.ts') || file.endsWith('.tsx')) return this.findCustomCssInTsFile(file, workspaceRoot);
        return [];
    }

    /** NEW_AND_MODIFIED_CODE: only hits whose line is in the diff hunks. */
    private findViolationsForModifiedCode(
        workspaceRoot: string,
        changedFiles: string[],
        base: string,
        head: string | undefined,
        disableAllowed: boolean,
    ): CssViolation[] {
        const violations: CssViolation[] = [];
        for (const file of changedFiles) {
            const changedLines = getChangedLineNumbers(getFileDiff(workspaceRoot, file, base, head));
            if (changedLines.size === 0) continue;
            for (const h of this.findHitsForFile(file, workspaceRoot)) {
                if (disableAllowed && h.hasDisableComment) continue;
                if (!changedLines.has(h.line)) continue;
                violations.push(new CssViolation(file, h.line, h.column, h.detail));
            }
        }
        return violations;
    }

    /** NEW_AND_MODIFIED_FILES: all hits in any changed file. */
    private findViolationsForModifiedFiles(workspaceRoot: string, changedFiles: string[], disableAllowed: boolean): CssViolation[] {
        const violations: CssViolation[] = [];
        for (const file of changedFiles) {
            for (const h of this.findHitsForFile(file, workspaceRoot)) {
                if (disableAllowed && h.hasDisableComment) continue;
                violations.push(new CssViolation(file, h.line, h.column, h.detail));
            }
        }
        return violations;
    }

    /** Flag styles:/styleUrls:/styleUrl: properties inside an `@Component({...})` decorator. */
    private findCustomCssInTsFile(filePath: string, workspaceRoot: string): CssHit[] {
        const fullPath = path.join(workspaceRoot, filePath);
        if (!fs.existsSync(fullPath)) return [];
        const content = fs.readFileSync(fullPath, 'utf-8');
        const fileLines = content.split('\n');
        const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
        const hits: CssHit[] = [];
        this.collectTsHits(sourceFile, sourceFile, fileLines, hits);
        return hits;
    }

    /** Recurse the AST; every `@Component(...)` decorator contributes its banned style props. */
    private collectTsHits(node: ts.Node, sourceFile: ts.SourceFile, fileLines: string[], hits: CssHit[]): void {
        if (ts.isDecorator(node)) this.collectComponentStyleProps(node, sourceFile, fileLines, hits);
        ts.forEachChild(node, (child: ts.Node) => this.collectTsHits(child, sourceFile, fileLines, hits));
    }

    /** Pull the banned style props out of a single `@Component(...)` decorator node. */
    private collectComponentStyleProps(node: ts.Decorator, sourceFile: ts.SourceFile, fileLines: string[], hits: CssHit[]): void {
        const expr = node.expression;
        if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression) || expr.expression.text !== 'Component') return;
        const arg = expr.arguments[0];
        if (!arg || !ts.isObjectLiteralExpression(arg)) return;
        for (const prop of arg.properties) {
            if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
            const name = prop.name.text;
            if (!STYLE_PROPS.has(name)) continue;
            const pos = sourceFile.getLineAndCharacterOfPosition(prop.getStart(sourceFile));
            const line = pos.line + 1;
            hits.push(new CssHit(line, pos.character + 1, `\`${name}\` block in @Component`, this.hasDisableComment(fileLines, line)));
        }
    }

    /** Flag inline style=, [style.x]/[style], and [ngStyle] in an Angular template via a line scan. */
    private findCustomCssInHtmlFile(filePath: string, workspaceRoot: string): CssHit[] {
        const fullPath = path.join(workspaceRoot, filePath);
        if (!fs.existsSync(fullPath)) return [];
        const fileLines = fs.readFileSync(fullPath, 'utf-8').split('\n');
        const hits: CssHit[] = [];
        for (let i = 0; i < fileLines.length; i++) {
            const detail = this.detailForTemplateLine(fileLines[i] ?? '');
            if (!detail) continue;
            const line = i + 1;
            hits.push(new CssHit(line, 1, detail, this.hasDisableComment(fileLines, line)));
        }
        return hits;
    }

    /** The banned-pattern label for a template line, or '' when the line is clean. */
    private detailForTemplateLine(raw: string): string {
        if (RE_NG_STYLE.test(raw)) return 'inline `[ngStyle]`';
        if (RE_STYLE_BINDING.test(raw)) return 'inline `[style.x]` binding';
        if (RE_INLINE_STYLE.test(raw)) return 'inline `style=` attribute';
        return '';
    }

    /** True if a `webpieces-disable no-custom-css` marker sits on this line or up to 3 lines above. */
    private hasDisableComment(lines: string[], lineNumber: number): boolean {
        const start = Math.max(0, lineNumber - 4);
        for (let i = lineNumber - 1; i >= start; i--) {
            if (hasDisable(lines[i] ?? '', RULE_NAMES.NO_CUSTOM_CSS)) return true;
        }
        return false;
    }

    private resolveMode(normalMode: ModifiedCodeMode, epoch: number | undefined, branchPattern: string | undefined): ModifiedCodeMode {
        if (normalMode === 'OFF') return normalMode;
        const skip = shouldSkipRule(epoch, branchPattern);
        if (skip.skip) {
            console.log(`\n⏭️  Skipping no-custom-css validation (${skip.reason})\n`);
            return 'OFF';
        }
        return normalMode;
    }

    private reportViolations(violations: CssViolation[], mode: ModifiedCodeMode): void {
        console.error('');
        console.error('❌ Custom CSS found in Angular source! Style with Tailwind utility classes instead.');
        console.error('');
        console.error('📚 Tailwind-first keeps styling in the template, greppable and consistent:');
        console.error('   BAD:   styles: [".card { display: flex; gap: 1rem; }"]');
        console.error('   GOOD:  class="flex gap-4"');
        console.error('   BAD:   <div style="width: 240px">  |  [style.width]  |  [ngStyle]');
        console.error('   GOOD:  <div class="w-[240px]">     |  [class.x] toggles');
        console.error('');
        for (const v of violations) {
            console.error(`  ❌ ${v.file}:${v.line}:${v.column}`);
            console.error(`     ${v.detail}`);
        }
        console.error('');
        console.error('   To fix: delete the CSS and use Tailwind utility classes (arbitrary values like');
        console.error('   `bg-[#fffde7]` / `grid-cols-[2fr_2fr_2fr_48px]` cover the long tail).');
        console.error('');
        console.error('   Escape hatch (genuinely dynamic runtime value, use sparingly):');
        console.error('   .ts   // webpieces-disable no-custom-css -- <reason>');
        console.error('   .html <!-- webpieces-disable no-custom-css -- <reason> -->');
        console.error('');
        console.error(`   Current mode: ${mode}`);
        console.error('');
    }
}
