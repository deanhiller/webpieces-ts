/**
 * Tests for max-file-lines ESLint rule
 */

import { RuleTester } from 'eslint';
import rule from '../rules/max-file-lines';
import * as fs from 'fs';
import * as path from 'path';

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

ruleTester.run('max-file-lines', rule, {
    valid: [
        // Short file (well under limit)
        {
            code: `function shortFunc() {
    return 42;
}`,
        },
        // File with exactly 700 lines (default limit)
        {
            code: Array(700)
                .fill(0)
                .map((_, i) => `const line${i} = ${i};`)
                .join('\n'),
        },
        // File with 699 lines (just under default limit)
        {
            code: Array(699)
                .fill(0)
                .map((_, i) => `const line${i} = ${i};`)
                .join('\n'),
        },
        // Custom limit: 10 lines
        {
            code: `function shortFunc() {
    const a = 1;
    const b = 2;
    const c = 3;
    const d = 4;
    const e = 5;
    return a + b + c + d + e;
}`,
            options: [{ max: 10 }],
        },
        // Empty file
        {
            code: '',
        },
        // File with comments and blank lines (all count)
        {
            code: `// Comment line 1
// Comment line 2

function func() {
    return 42;
}

// Another comment`,
            options: [{ max: 10 }],
        },
    ],

    invalid: [
        // File with 701 lines (exceeds default limit)
        {
            code: Array(701)
                .fill(0)
                .map((_, i) => `const line${i} = ${i};`)
                .join('\n'),
            errors: [
                {
                    messageId: 'tooLong',
                    data: { actual: '701', max: '700' },
                },
            ],
        },
        // File with 1000 lines (way over limit)
        {
            code: Array(1000)
                .fill(0)
                .map((_, i) => `const line${i} = ${i};`)
                .join('\n'),
            errors: [
                {
                    messageId: 'tooLong',
                    data: { actual: '1000', max: '700' },
                },
            ],
        },
        // Custom limit: exceed 5 lines
        {
            code: `function func() {
    const a = 1;
    const b = 2;
    const c = 3;
    const d = 4;
    return a + b + c + d;
}`,
            options: [{ max: 5 }],
            errors: [
                {
                    messageId: 'tooLong',
                    data: { actual: '7', max: '5' },
                },
            ],
        },
        // Custom limit: exceed 100 lines
        {
            code: Array(101)
                .fill(0)
                .map((_, i) => `const line${i} = ${i};`)
                .join('\n'),
            options: [{ max: 100 }],
            errors: [
                {
                    messageId: 'tooLong',
                    data: { actual: '101', max: '100' },
                },
            ],
        },
        // File with blank lines and comments (all lines count)
        {
            code: `// Line 1
// Line 2
// Line 3

function func() {
    return 42;
}

// Line 9
// Line 10
// Line 11`,
            options: [{ max: 10 }],
            errors: [
                {
                    messageId: 'tooLong',
                    data: { actual: '11', max: '10' },
                },
            ],
        },
    ],
});

console.log('✅ All max-file-lines rule tests passed!');

// Test documentation file creation
const docPath = path.join(process.cwd(), 'tmp', 'webpieces', 'webpieces.filesize.md');

// Run a test that triggers violation
try {
    ruleTester.run('max-file-lines-doc-test', rule, {
        valid: [],
        invalid: [
            {
                code: Array(800)
                    .fill(0)
                    .map((_, i) => `const line${i} = ${i};`)
                    .join('\n'),
                errors: [{ messageId: 'tooLong' }],
            },
        ],
    });
} catch (err: any) {
    //const error = toError(err);
    // Test may fail, but file should be created
}

// Verify file was created
if (!fs.existsSync(docPath)) {
    throw new Error('Documentation file was not created at ' + docPath);
}

// Verify content has AI directive
const content = fs.readFileSync(docPath, 'utf-8');
if (!content.includes('READ THIS FILE to fix files that are too long')) {
    throw new Error('Documentation file missing AI directive');
}
if (!content.includes('SINGLE COHESIVE UNIT')) {
    throw new Error('Documentation file missing single cohesive unit principle');
}

console.log('✅ Documentation file creation test passed!');
