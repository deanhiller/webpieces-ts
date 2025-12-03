/**
 * Tests for max-method-lines ESLint rule
 */

import { RuleTester } from 'eslint';
import rule from '../rules/max-method-lines';
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

ruleTester.run('max-method-lines', rule, {
    valid: [
        // Short function (well under limit)
        {
            code: `function shortFunc() {
    return 42;
}`,
        },
        // Function with exactly 70 lines (default limit)
        {
            code: `function exactlySeventyLines() {
${Array(68)
    .fill(0)
    .map((_, i) => `    const line${i} = ${i};`)
    .join('\n')}
}`,
        },
        // Function with 69 lines (just under default limit)
        {
            code: `function sixtyNineLines() {
${Array(67)
    .fill(0)
    .map((_, i) => `    const line${i} = ${i};`)
    .join('\n')}
}`,
        },
        // Custom limit: 10 lines
        {
            code: `function shortFunc() {
    const a = 1;
    const b = 2;
    const c = 3;
    const d = 4;
    const e = 5;
    const f = 6;
    const g = 7;
    return a + b + c + d + e + f + g;
}`,
            options: [{ max: 10 }],
        },
        // Arrow function under limit
        {
            code: `const shortArrow = () => {
    return 42;
};`,
        },
        // Method definition under limit
        {
            code: `class MyClass {
    shortMethod() {
        return 42;
    }
}`,
        },
        // Function expression under limit
        {
            code: `const func = function() {
    return 42;
};`,
        },
    ],

    invalid: [
        // Function with 71 lines (exceeds default limit)
        {
            code: `function tooLong() {
${Array(69)
    .fill(0)
    .map((_, i) => `    const line${i} = ${i};`)
    .join('\n')}
}`,
            errors: [
                {
                    messageId: 'tooLong',
                    data: { name: 'tooLong', actual: '71', max: '70' },
                },
            ],
        },
        // Function with 100 lines (way over limit)
        {
            code: `function wayTooLong() {
${Array(98)
    .fill(0)
    .map((_, i) => `    const line${i} = ${i};`)
    .join('\n')}
}`,
            errors: [
                {
                    messageId: 'tooLong',
                    data: { name: 'wayTooLong', actual: '100', max: '70' },
                },
            ],
        },
        // Custom limit: exceed 5 lines
        {
            code: `function tooLongForCustom() {
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
                    data: { name: 'tooLongForCustom', actual: '7', max: '5' },
                },
            ],
        },
        // Arrow function exceeding limit
        {
            code: `const tooLongArrow = () => {
${Array(69)
    .fill(0)
    .map((_, i) => `    const line${i} = ${i};`)
    .join('\n')}
};`,
            errors: [
                {
                    messageId: 'tooLong',
                    data: { name: 'anonymous', actual: '71', max: '70' },
                },
            ],
        },
        // Method definition exceeding limit
        {
            code: `class MyClass {
    tooLongMethod() {
${Array(69)
    .fill(0)
    .map((_, i) => `        const line${i} = ${i};`)
    .join('\n')}
    }
}`,
            errors: [
                {
                    messageId: 'tooLong',
                    data: { name: 'tooLongMethod', actual: '71', max: '70' },
                },
            ],
        },
        // Function expression exceeding limit
        {
            code: `const func = function tooLongFunc() {
${Array(69)
    .fill(0)
    .map((_, i) => `    const line${i} = ${i};`)
    .join('\n')}
};`,
            errors: [
                {
                    messageId: 'tooLong',
                    data: { name: 'tooLongFunc', actual: '71', max: '70' },
                },
            ],
        },
        // Multiple functions, one exceeds limit
        {
            code: `function shortFunc() {
    return 42;
}

function tooLong() {
${Array(69)
    .fill(0)
    .map((_, i) => `    const line${i} = ${i};`)
    .join('\n')}
}

function anotherShort() {
    return 24;
}`,
            errors: [
                {
                    messageId: 'tooLong',
                    data: { name: 'tooLong', actual: '71', max: '70' },
                },
            ],
        },
    ],
});

console.log('✅ All max-method-lines rule tests passed!');

// Test documentation file creation
const docPath = path.join(process.cwd(), 'tmp', 'webpieces', 'webpieces.methods.md');

// Run a test that triggers violation (will create doc file)
try {
    ruleTester.run('max-method-lines-doc-test', rule, {
        valid: [],
        invalid: [
            {
                code: `function veryLongMethod() {
${Array(100)
    .fill(0)
    .map((_, i) => `    const line${i} = ${i};`)
    .join('\n')}
}`,
                errors: [{ messageId: 'tooLong' }],
            },
        ],
    });
} catch {
    // Test may fail due to too many errors, but file should be created
}

// Verify file was created
if (!fs.existsSync(docPath)) {
    throw new Error('Documentation file was not created at ' + docPath);
}

// Verify content has AI directive
const content = fs.readFileSync(docPath, 'utf-8');
if (!content.includes('READ THIS FILE to fix methods that are too long')) {
    throw new Error('Documentation file missing AI directive');
}
if (!content.includes('TABLE OF CONTENTS')) {
    throw new Error('Documentation file missing table of contents principle');
}

console.log('✅ Documentation file creation test passed!');
