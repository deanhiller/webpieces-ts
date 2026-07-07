/**
 * Tests for no-process-exit-outside-main ESLint rule.
 *
 * The rule allows process.exit ONLY inside a function named `main` or `runMain`, and forbids
 * importing another module's `main` (the pattern that let git-gatherInfo's exiting main kill
 * wp-start-upsert-pr).
 */

import { RuleTester } from 'eslint';
import rule from '../rules/no-process-exit-outside-main';

// Use require to load parser at runtime (avoids TypeScript import issues)
const tsParser = require('@typescript-eslint/parser');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: tsParser,
        parserOptions: {
            ecmaVersion: 2020,
            sourceType: 'module',
        },
    },
});

ruleTester.run('no-process-exit-outside-main', rule, {
    valid: [
        // Inside a function declaration named `main`.
        { code: `function main() { process.exit(1); }` },
        // Inside an async `main`.
        { code: `async function main() { process.exit(0); }` },
        // Inside an arrow assigned to `const main`.
        { code: `const main = () => { process.exit(2); };` },
        // Inside the shared `runMain` wrapper, even nested in a .catch arrow.
        { code: `function runMain(main) { main().catch((e) => { process.exit(1); }); }` },
        // Importing a non-`main` symbol is fine.
        { code: `import { gatherInfo } from './git-gatherInfo';` },
        // process.exitCode assignment is not a process.exit() call.
        { code: `function helper() { process.exitCode = 1; }` },
    ],

    invalid: [
        // Top-level (module scope) exit — not inside any main/runMain.
        {
            code: `process.exit(1);`,
            errors: [{ messageId: 'noProcessExit' }],
        },
        // Inside a non-main library function — the dangerous case.
        {
            code: `function assertCleanTree() { process.exit(1); }`,
            errors: [{ messageId: 'noProcessExit' }],
        },
        // Inside a function named something else entirely.
        {
            code: `export function gatherInfo() { process.exit(0); }`,
            errors: [{ messageId: 'noProcessExit' }],
        },
        // Importing another module's `main` (plain).
        {
            code: `import { main } from './cleanTmp';`,
            errors: [{ messageId: 'noImportMain' }],
        },
        // Importing another module's `main` aliased — the exact git-gatherInfo bug shape.
        {
            code: `import { main as gatherInfo } from './git-gatherInfo';`,
            errors: [{ messageId: 'noImportMain' }],
        },
    ],
});

console.log('All no-process-exit-outside-main rule tests passed!');
