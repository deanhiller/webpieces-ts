/**
 * ESLint rule: no-process-exit-outside-main
 *
 * Enforces the codebase invariant: `process.exit` may appear ONLY inside a function named `main`
 * (a bin's terminal boundary) or inside the shared `runMain` wrapper. Everywhere else — especially a
 * library function that another module imports and calls — a `process.exit` silently kills the PARENT
 * process. That is exactly the bug this rule prevents: `git-gatherInfo`'s `main()` called
 * `process.exit(0)` while imported by `merge-start`, so it killed `wp-start-upsert-pr` mid-flow (with
 * a SUCCESS code) and push + build were skipped. Library code must instead `throw CliExitError(code,
 * msg)` and let `main()` / `runMain` translate it into the single sanctioned exit.
 *
 * Two checks:
 *  1. `process.exit(...)` outside a `main`/`runMain` function → error (throw CliExitError instead).
 *  2. `import { main }` / `import { main as X }` from another module → error. `main` is a bin entry
 *     point, not a library export; importing it is what let a library call another module's exiting
 *     `main`. Call a named function; each bin owns its own thin `main()` + `runMain` wrapper.
 *
 * Genuine terminal boundaries that are not named `main` (a server bootstrap, a hook's exit-code
 * protocol) use an inline `// eslint-disable-next-line @webpieces/no-process-exit-outside-main --
 * <reason>` with a justification.
 */

import type { Rule } from 'eslint';

// Minimal structural view of the ESTree/ESLint AST nodes this rule inspects — only the fields we
// read, declared as named properties (no index signature) so access stays type-checked.
interface AstNode {
    type: string;
    name?: string;
    computed?: boolean;
    callee?: AstNode;
    object?: AstNode;
    property?: AstNode;
    id?: AstNode;
    parent?: AstNode;
    imported?: AstNode;
    specifiers?: AstNode[];
}

const ALLOWED_FUNCTION_NAMES = ['main', 'runMain'];

const rule: Rule.RuleModule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'process.exit() only inside main()/runMain; never import another module\'s main',
        },
        messages: {
            noProcessExit:
                'Do not call process.exit() here. Only a function named `main` (or the shared `runMain` ' +
                'wrapper) may exit the process — library code that another module calls would otherwise ' +
                'silently kill the parent process. Throw `CliExitError(code, message)` and let main()/runMain ' +
                'translate it. Genuine terminal boundary? Add `// eslint-disable-next-line ' +
                '@webpieces/no-process-exit-outside-main -- <reason>`.',
            noImportMain:
                'Do not import another module\'s `main`. `main` is a bin entry point, not a library export; ' +
                'importing it is what lets library code call an exiting `main` and kill the parent process. ' +
                'Export and import a named function instead, and give each bin its own thin main()/runMain wrapper.',
        },
        schema: [],
    },
    create(context: Rule.RuleContext): Rule.RuleListener {
        // Listener params are typed with our minimal AstNode; ESLint passes ESTree nodes, so the whole
        // listener object is cast to Rule.RuleListener once at the return (rather than per-node).
        const listener = {
            CallExpression(node: AstNode): void {
                // Match `process.exit(...)` exactly (not computed, not some other object).
                const callee: AstNode | undefined = node.callee as AstNode | undefined;
                if (!callee || callee.type !== 'MemberExpression' || callee.computed) return;
                const obj: AstNode = callee.object as AstNode;
                const prop: AstNode = callee.property as AstNode;
                const isExit = obj.type === 'Identifier' && obj.name === 'process' && prop.type === 'Identifier' && prop.name === 'exit';
                if (!isExit) return;

                // Allow only when lexically inside a function named `main` or `runMain`.
                // webpieces-disable no-any-unknown -- bridge our loose AstNode to ESLint's Rule.Node for the ancestor API.
                const ancestors = context.sourceCode.getAncestors(node as unknown as Rule.Node) as unknown as AstNode[];
                let allowed = false;
                for (const anc of ancestors) {
                    if (anc.type !== 'FunctionDeclaration' && anc.type !== 'FunctionExpression' && anc.type !== 'ArrowFunctionExpression') {
                        continue;
                    }
                    // Name: `function main()` (declaration id) or `const main = () => {}` (declarator).
                    let name: string | null = null;
                    if (anc.id && typeof anc.id.name === 'string') {
                        name = anc.id.name;
                    } else {
                        const parent: AstNode | undefined = anc.parent as AstNode | undefined;
                        if (parent && parent.type === 'VariableDeclarator' && parent.id && typeof parent.id.name === 'string') {
                            name = parent.id.name;
                        }
                    }
                    if (name !== null && ALLOWED_FUNCTION_NAMES.includes(name)) {
                        allowed = true;
                        break;
                    }
                }
                if (allowed) return;
                // webpieces-disable no-any-unknown -- ESTree AST cast for ESLint report.
                context.report({ node: node as unknown as Rule.Node, messageId: 'noProcessExit' });
            },
            ImportDeclaration(node: AstNode): void {
                for (const spec of node.specifiers as AstNode[]) {
                    if (spec.type === 'ImportSpecifier' && spec.imported && spec.imported.name === 'main') {
                        // webpieces-disable no-any-unknown -- ESTree AST cast for ESLint report.
                        context.report({ node: spec as unknown as Rule.Node, messageId: 'noImportMain' });
                    }
                }
            },
        };
        // webpieces-disable no-any-unknown -- our AstNode listener params bridge to ESLint's node types.
        return listener as unknown as Rule.RuleListener;
    },
};

export = rule;
