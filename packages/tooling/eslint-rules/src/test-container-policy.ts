/**
 * TestContainerPolicy — decides whether a function node is a test-framework CONTAINER
 * callback inside a test file, and therefore not a "method" worth measuring.
 *
 * A `describe('...', () => { ... })` block groups cases; its line count reflects how many
 * cases a behaviour needs, not how much logic one unit carries. Splitting it to satisfy a
 * production-method line limit invents structure that maps to nothing. Everything else in a
 * spec file - `it` bodies, hooks, helper functions - is still measured, and NOTHING in a
 * non-test file is ever exempt.
 */

export const DEFAULT_TEST_CONTAINERS: readonly string[] = ['describe', 'suite', 'context'];

/** Matches foo.spec.ts / foo.test.tsx / foo.spec.mjs etc. */
export const DEFAULT_TEST_FILE_PATTERN = '\\.(spec|test)\\.[cm]?[jt]sx?$';

export class TestContainerPolicy {
    private readonly containers: Set<string>;
    private readonly testFileRegex: RegExp;

    constructor(containers?: readonly string[], testFilePattern?: string) {
        this.containers = new Set(containers ?? DEFAULT_TEST_CONTAINERS);
        this.testFileRegex = new RegExp(testFilePattern ?? DEFAULT_TEST_FILE_PATTERN);
    }

    isTestFile(filename: string): boolean {
        return this.testFileRegex.test(filename.replace(/\\/g, '/'));
    }

    /**
     * True only when `node` is a function passed as an argument DIRECTLY to a call whose
     * base callee is a configured container name (describe, describe.only, describe.each(...)),
     * inside a test file.
     */
    // webpieces-disable no-any-unknown -- ESTree AST nodes require any for dynamic properties
    isExemptContainerCallback(filename: string, node: any): boolean {
        if (!this.isTestFile(filename)) return false;

        const parent = node?.['parent'];
        if (!parent || parent.type !== 'CallExpression') return false;
        if (!Array.isArray(parent.arguments) || !parent.arguments.includes(node)) return false;

        const base = this.baseCalleeName(parent.callee);
        return base !== null && this.containers.has(base);
    }

    /**
     * Walks `describe`, `describe.only`, `describe.each([...])` down to the root identifier
     * name so every dialect of the same container is recognised.
     */
    // webpieces-disable no-any-unknown -- ESTree AST nodes require any for dynamic properties
    private baseCalleeName(callee: any): string | null {
        let current = callee;
        while (current) {
            if (current.type === 'Identifier') return current.name ?? null;
            if (current.type === 'MemberExpression') {
                current = current.object;
                continue;
            }
            if (current.type === 'CallExpression' || current.type === 'TaggedTemplateExpression') {
                current = current.callee ?? current.tag;
                continue;
            }
            return null;
        }
        return null;
    }
}
