import * as ts from 'typescript';
import { MIN_DISABLE_REASON, SiteDisables } from './source-syntax';

/**
 * `catch-must-propagate` (#1313): a caught error must PROPAGATE — never be replaced by its message.
 *
 * The bug it closes: a catch stored `error.message` in a string field and let the error go; later a
 * different class threw a generic error with no cause. `throw-cause-required` never fired, because no
 * throw happened inside the catch. So this judges the catch itself. A `catch` clause (or a
 * `.catch(handler)` callback) must do at least one of, with the caught error WHOLE:
 *
 *   - rethrow it, or throw a new error carrying it (`{ cause: err }`, or as a constructor argument);
 *   - pass it to a configured forwarder / logger callee (`log.warn('x', err)`, `reject(err)`);
 *   - return it (`return err`, `return { error: err }`);
 *   - store it on a member (`this.lastError = err`, `decoded.cause = err`).
 *
 * "Whole" means the binding (or a local initialised from it, e.g. `const error = toError(err)`) appears
 * as a VALUE — not only through `err.message`, `String(err)`, `JSON.stringify(err)`, a template or `+`.
 * A binding-less `catch {}`, an unused or destructured binding, and a callback with no parameter all
 * drop the error. Nested function bodies are not searched: a throw in a callback runs later, on another
 * stack, and never propagates to this caller.
 *
 * SYNTAX ONLY, on purpose: the guard (one proposed file) and the gate (`wp-build`) parse the same text
 * with this same module, so they give the same verdict at the same line. Nothing here may need types.
 *
 * The one escape is per site, with a written reason of at least {@link MIN_DISABLE_REASON} characters:
 * `// webpieces-disable catch-must-propagate -- <reason>` on the catch's line or the line above it.
 * Only that line-comment form exists; there is no block or file form to honour.
 */
export class CatchFinding {
    constructor(
        /** 1-based line of the `catch` keyword — where the finding is reported and a disable aims. */
        readonly line: number,
        /** 1-based last line of the catch clause or callback; a changed line anywhere in it judges it. */
        readonly endLine: number,
        /** The reported line's source text, trimmed. */
        readonly snippet: string,
        /** Why THIS catch drops its error — the diagnosis, not the cure. */
        readonly message: string,
    ) {}
}

/** The rule id, shared by both runners and every message. */
export const CATCH_MUST_PROPAGATE = 'catch-must-propagate';

/** One cure, worded once for both runners; each renders it as its own `Option`. Data-only. */
export class CatchCure {
    constructor(readonly text: string, readonly preferred: boolean) {}
}

/** The cures both runners print, so the guard and the gate teach the same fix. */
export const CATCH_MUST_PROPAGATE_CURES: readonly CatchCure[] = [
    new CatchCure('Remove the try/catch and let the error bubble: the top-level handler logs it with its stack and cause chain.', true),
    new CatchCure("Rethrow it, or throw a new error that carries it: throw new Error('<what failed>', { cause: error }).", false),
    new CatchCure(`Hand it WHOLE to a logger or forwarder listed in ${CATCH_MUST_PROPAGATE}.forwards (log.warn('<what failed>', error)), ` +
        `or add your own helper's name to that list in the rule's config entry.`, false),
    new CatchCure('Return it whole, or store it whole on a member (this.lastError = error) where a later throw carries it on.', false),
];

/** The one per-site escape both runners print. */
export const CATCH_MUST_PROPAGATE_DISABLE =
    `// webpieces-disable ${CATCH_MUST_PROPAGATE} -- <why dropping this error is correct, at least ${MIN_DISABLE_REASON} characters>`;

const TEST_PATH = /(\.(spec|test)\.[cm]?tsx?$)|(^|\/)__tests__\//;
const SOURCE_PATH = /\.[cm]?tsx?$/;

/** One catch to judge: where it is, its error binding and its body. Data-only. */
class CatchSite {
    constructor(
        readonly start: number,
        readonly end: number,
        readonly binding: ts.BindingName | undefined,
        readonly body: ts.ConciseBody,
        readonly kind: string,
    ) {}
}

/** What one catch does with its error: which references exist, and where whole values went. */
class CatchUse {
    references = 0;
    partOnly = 0;
    /** Callees the error was passed to WHOLE that are not configured forwarders. */
    readonly unconfigured = new Set<string>();
    propagated = false;
}

/**
 * The analyzer both runners call. Construct it with the repo's configured forwarder callee names
 * (`forwards` in the rule's config entry — required, no default), then {@link analyze} one parse.
 */
export class CatchPropagationAnalyzer {
    private readonly forwards: readonly string[];

    constructor(forwards: readonly string[]) {
        this.forwards = forwards;
    }

    /** Is `relativePath` a TypeScript source this rule judges? Declarations and test files are not. */
    judges(relativePath: string): boolean {
        const normalized = relativePath.split('\\').join('/');
        if (!SOURCE_PATH.test(normalized) || /\.d\.[cm]?ts$/.test(normalized)) return false;
        return !TEST_PATH.test(normalized);
    }

    /**
     * Every catch in `source` that drops its error and is not disabled with a reason. With
     * `changedLines`, only a catch whose clause spans a changed line is judged (NEW_AND_MODIFIED_CODE).
     */
    analyze(source: ts.SourceFile, changedLines?: ReadonlySet<number>): CatchFinding[] {
        const lines = source.text.split('\n');
        const directives = new SiteDisables(source.text, CATCH_MUST_PROPAGATE);
        const findings: CatchFinding[] = [];
        const visit = (node: ts.Node): void => {
            const finding = this.judgeNode(source, lines, node);
            if (finding && this.inScope(finding, changedLines)) {
                const exemption = this.exempted(directives, finding);
                if (exemption !== true) findings.push(exemption ?? finding);
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        return findings;
    }

    private inScope(finding: CatchFinding, changedLines?: ReadonlySet<number>): boolean {
        if (changedLines === undefined) return true;
        for (let line = finding.line; line <= finding.endLine; line++) if (changedLines.has(line)) return true;
        return false;
    }

    /** true = exempt; a finding = the disable is there but carries no usable reason; undefined = none. */
    private exempted(directives: SiteDisables, finding: CatchFinding): true | CatchFinding | undefined {
        const reason = directives.reasonAt(finding.line);
        if (reason === undefined) return undefined;
        if (reason.length >= MIN_DISABLE_REASON) return true;
        return new CatchFinding(finding.line, finding.endLine, finding.snippet,
            `${finding.message} The \`// webpieces-disable ${CATCH_MUST_PROPAGATE}\` aimed at it does not exempt it: ` +
                `it needs a written reason after \` -- \` of at least ${MIN_DISABLE_REASON} characters, ` +
                `the only record of why this one site may drop its error.`);
    }

    /** A finding when `node` is a catch clause or `.catch(callback)` that drops its error. */
    private judgeNode(source: ts.SourceFile, lines: readonly string[], node: ts.Node): CatchFinding | undefined {
        if (ts.isCatchClause(node)) {
            const site = new CatchSite(node.getStart(source), node.getEnd(), node.variableDeclaration?.name, node.block, 'catch');
            return this.verdict(source, lines, site);
        }
        if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
        if (node.expression.name.text !== 'catch') return undefined;
        const handler = node.arguments[0];
        if (handler === undefined || !(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) return undefined;
        const site = new CatchSite(node.expression.name.getStart(source), node.getEnd(), handler.parameters[0]?.name,
            handler.body, '.catch() callback');
        return this.verdict(source, lines, site);
    }

    private verdict(source: ts.SourceFile, lines: readonly string[], site: CatchSite): CatchFinding | undefined {
        const line = source.getLineAndCharacterOfPosition(site.start).line + 1;
        const endLine = source.getLineAndCharacterOfPosition(site.end).line + 1;
        const binding = site.binding;
        const kind = site.kind;
        const snippet = (lines[line - 1] ?? '').trim();
        if (binding === undefined) {
            return new CatchFinding(line, endLine, snippet, `This ${kind} has no error binding, so the caught error is dropped.`);
        }
        if (!ts.isIdentifier(binding)) {
            return new CatchFinding(line, endLine, snippet,
                `This ${kind} destructures the caught error, keeping only its parts — the stack, type and cause chain are dropped.`);
        }
        const use = this.use(new Set([binding.text]), site.body);
        if (use.propagated) return undefined;
        return new CatchFinding(line, endLine, snippet, this.diagnosis(kind, binding.text, use));
    }

    private diagnosis(kind: string, name: string, use: CatchUse): string {
        if (use.references === 0) return `This ${kind} never uses \`${name}\`, so the caught error is dropped.`;
        if (use.unconfigured.size > 0) {
            const callees = [...use.unconfigured].map((callee: string) => `${callee}()`).join(', ');
            return `This ${kind} passes \`${name}\` whole only to ${callees}, which is not a configured forwarder ` +
                `(${CATCH_MUST_PROPAGATE}.forwards), so the rule cannot see the error propagate.`;
        }
        if (use.partOnly === use.references) {
            return `This ${kind} uses \`${name}\` only through its text or a test of it (\`.message\`, \`String()\`, a template, \`+\`, \`instanceof\`), ` +
                `which replaces the cause: the stack, the type and the cause chain are gone for good.`;
        }
        return `This ${kind} keeps \`${name}\` in a local but never rethrows it, forwards it, returns it or stores it on a member.`;
    }

    /** Grow the alias set to a fixpoint, then decide whether any alias propagates. */
    private use(names: Set<string>, body: ts.Node): CatchUse {
        let grew = true;
        while (grew) {
            grew = false;
            this.walk(body, (node: ts.Node) => {
                const alias = this.aliasOf(node, names);
                if (alias !== undefined && !names.has(alias)) {
                    names.add(alias);
                    grew = true;
                }
            });
        }
        const use = new CatchUse();
        if (!ts.isBlock(body)) this.record(body, names, use);
        this.walk(body, (node: ts.Node) => this.record(node, names, use));
        if (!ts.isBlock(body) && this.carriesWhole(body, names)) use.propagated = true;
        return use;
    }

    /** `const e = toError(err)` / `e = err as Error` makes `e` an alias of the caught error. */
    private aliasOf(node: ts.Node, names: ReadonlySet<string>): string | undefined {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            return this.carriesWhole(node.initializer, names) ? node.name.text : undefined;
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
            return this.carriesWhole(node.right, names) ? node.left.text : undefined;
        }
        return undefined;
    }

    private record(node: ts.Node, names: ReadonlySet<string>, use: CatchUse): void {
        if (ts.isIdentifier(node) && names.has(node.text) && this.isReference(node)) {
            use.references++;
            if (!this.isWholeAt(this.unwrap(node))) use.partOnly++;
        }
        if (use.propagated) return;
        if ((ts.isThrowStatement(node) || ts.isReturnStatement(node)) && node.expression) {
            use.propagated = this.carriesWhole(node.expression, names);
        } else if (ts.isCallExpression(node) && node.arguments.some((arg: ts.Expression) => this.carriesWhole(arg, names))) {
            const callee = this.calleeName(node.expression);
            if (this.isForwarder(node.expression)) use.propagated = true;
            else if (callee !== undefined && callee !== 'toError') use.unconfigured.add(callee);
        } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
            use.propagated = this.carriesWhole(node.right, names);
        }
    }

    private calleeName(callee: ts.Expression): string | undefined {
        if (ts.isIdentifier(callee)) return callee.text;
        if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
        return undefined;
    }

    /** An entry without a dot names the final callee (`warn`); one with a dot the call's tail (`logger.warn`). */
    private isForwarder(callee: ts.Expression): boolean {
        const name = this.calleeName(callee);
        const text = callee.getText().replace(/\s+/g, '').replace(/\?\./g, '.');
        return this.forwards.some((entry: string) =>
            entry.includes('.') ? text === entry || text.endsWith(`.${entry}`) : entry === name);
    }

    /** True when `node` holds one of `names` as a WHOLE value somewhere — never only its text. */
    private carriesWhole(node: ts.Node, names: ReadonlySet<string>): boolean {
        let whole = false;
        const check = (child: ts.Node): void => {
            if (!whole && ts.isIdentifier(child) && names.has(child.text) && this.isReference(child)) {
                whole = this.isWholeAt(this.unwrap(child));
            }
        };
        check(node);
        this.walk(node, check);
        return whole;
    }

    /** Climb past re-typing and normalising: `err as Error`, `err!`, `(err)`, `toError(err)`. */
    private unwrap(node: ts.Node): ts.Node {
        let at = node;
        while (at.parent && this.wraps(at.parent, at)) at = at.parent;
        return at;
    }

    private wraps(parent: ts.Node, child: ts.Node): boolean {
        if (ts.isAsExpression(parent) || ts.isNonNullExpression(parent) || ts.isTypeAssertionExpression(parent)
            || ts.isParenthesizedExpression(parent) || ts.isSatisfiesExpression(parent)) return parent.expression === child;
        return ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'toError'
            && parent.arguments[0] === child;
    }

    /** Does the position `at` occupies keep the whole value (an argument, a field value, a thrown value…)? */
    private isWholeAt(at: ts.Node): boolean {
        const parent = at.parent;
        if (parent === undefined) return false;
        if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
            const args: readonly ts.Node[] = parent.arguments ?? [];
            return args.includes(at) && !this.isTextCall(parent.expression);
        }
        if (ts.isThrowStatement(parent) || ts.isReturnStatement(parent) || ts.isYieldExpression(parent)) return true;
        if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) return parent.initializer === at;
        if (ts.isShorthandPropertyAssignment(parent) || ts.isArrayLiteralExpression(parent)) return true;
        if (ts.isConditionalExpression(parent)) return parent.condition !== at;
        if (ts.isArrowFunction(parent)) return parent.body === at;
        if (!ts.isBinaryExpression(parent)) return false;
        const op = parent.operatorToken.kind;
        if (op === ts.SyntaxKind.EqualsToken) return parent.right === at;
        return op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken;
    }

    /** `String(err)` and `JSON.stringify(err)` keep only text: an Error's message and stack are not enumerable. */
    private isTextCall(callee: ts.Expression): boolean {
        const text = callee.getText().replace(/\s+/g, '');
        return text === 'String' || text === 'JSON.stringify';
    }

    /** An identifier READ — not a property name, a declaration's name or a label. */
    private isReference(id: ts.Identifier): boolean {
        const parent = id.parent;
        if (parent === undefined) return true;
        if (ts.isPropertyAccessExpression(parent)) return parent.expression === id;
        if (ts.isQualifiedName(parent)) return parent.left === id;
        if (ts.isPropertyAssignment(parent) || ts.isBindingElement(parent)) return parent.initializer === id;
        if (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) return parent.initializer === id;
        if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
        return !(ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent));
    }

    /** Every node under `root`, not descending into nested functions, classes or type annotations. */
    private walk(root: ts.Node, visit: (node: ts.Node) => void): void {
        const step = (node: ts.Node): void => {
            visit(node);
            if (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isTypeNode(node)) return;
            ts.forEachChild(node, step);
        };
        ts.forEachChild(root, step);
    }
}
