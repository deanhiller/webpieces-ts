/**
 * Tests for catch-error-pattern ESLint rule
 */

import { RuleTester } from 'eslint';
import rule from '../rules/catch-error-pattern';

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

ruleTester.run('catch-error-pattern', rule, {
    valid: [
        // Pattern 1: Standard toError usage
        {
            code: `try {
    doSomething();
} catch (err: any) {
    const error = toError(err);
}`,
        },
        // Pattern 1 with additional statements after toError
        {
            code: `try {
    doSomething();
} catch (err: any) {
    const error = toError(err);
    console.log('Error occurred:', error);
    throw error;
}`,
        },
        // Pattern 2: Explicitly ignored error
        {
            code: `try {
    doSomething();
} catch (err: any) {
    //const error = toError(err);
}`,
        },
        // Pattern 2 with extra whitespace
        {
            code: `try {
    doSomething();
} catch (err: any) {
    // const error = toError(err);
}`,
        },
        // Pattern 3: Nested catch blocks
        {
            code: `try {
    doSomething();
} catch (err: any) {
    const error = toError(err);
    try {
        cleanup();
    } catch (err2: any) {
        const error2 = toError(err2);
    }
}`,
        },
        // Triple nested
        {
            code: `try {
    operation1();
} catch (err: any) {
    const error = toError(err);
    try {
        operation2();
    } catch (err2: any) {
        const error2 = toError(err2);
        try {
            operation3();
        } catch (err3: any) {
            const error3 = toError(err3);
        }
    }
}`,
        },
        // With finally block
        {
            code: `try {
    doSomething();
} catch (err: any) {
    const error = toError(err);
} finally {
    cleanup();
}`,
        },
        // Re-throwing after toError
        {
            code: `try {
    doSomething();
} catch (err: any) {
    const error = toError(err);
    logger.error(error);
    throw error;
}`,
        },
    ],

    invalid: [
        // Wrong parameter name (e instead of err)
        {
            code: `
                try {
                    doSomething();
                } catch (e: any) {
                    const error = toError(e);
                }
            `,
            errors: [
                {
                    messageId: 'wrongParameterName',
                    data: { actual: 'e' },
                },
            ],
        },
        // Wrong parameter name (error instead of err) AND wrong variable name
        {
            code: `
                try {
                    doSomething();
                } catch (error: any) {
                    const error2 = toError(error);
                }
            `,
            errors: [
                {
                    messageId: 'wrongParameterName',
                    data: { actual: 'error' },
                },
                {
                    messageId: 'wrongVariableName',
                    data: { expected: 'error', actual: 'error2' },
                },
            ],
        },
        // Missing type annotation
        {
            code: `
                try {
                    doSomething();
                } catch (err) {
                    const error = toError(err);
                }
            `,
            errors: [
                {
                    messageId: 'missingTypeAnnotation',
                },
            ],
        },
        // Wrong type annotation (Error instead of any)
        {
            code: `
                try {
                    doSomething();
                } catch (err: Error) {
                    const error = toError(err);
                }
            `,
            errors: [
                {
                    messageId: 'missingTypeAnnotation',
                },
            ],
        },
        // Empty catch block
        {
            code: `
                try {
                    doSomething();
                } catch (err: any) {
                }
            `,
            errors: [
                {
                    messageId: 'missingToError',
                },
            ],
        },
        // Missing toError call
        {
            code: `
                try {
                    doSomething();
                } catch (err: any) {
                    console.log(err);
                }
            `,
            errors: [
                {
                    messageId: 'missingToError',
                },
            ],
        },
        // Wrong variable name (e instead of error)
        {
            code: `
                try {
                    doSomething();
                } catch (err: any) {
                    const e = toError(err);
                }
            `,
            errors: [
                {
                    messageId: 'wrongVariableName',
                    data: { expected: 'error', actual: 'e' },
                },
            ],
        },
        // Wrong variable name (myError instead of error)
        {
            code: `
                try {
                    doSomething();
                } catch (err: any) {
                    const myError = toError(err);
                }
            `,
            errors: [
                {
                    messageId: 'wrongVariableName',
                    data: { expected: 'error', actual: 'myError' },
                },
            ],
        },
        // toError not first statement
        {
            code: `
                try {
                    doSomething();
                } catch (err: any) {
                    console.log('caught error');
                    const error = toError(err);
                }
            `,
            errors: [
                {
                    messageId: 'missingToError',
                },
            ],
        },
        // Using wrong function (not toError)
        {
            code: `
                try {
                    doSomething();
                } catch (err: any) {
                    const error = handleError(err);
                }
            `,
            errors: [
                {
                    messageId: 'missingToError',
                },
            ],
        },
        // Nested: wrong parameter name for err2
        {
            code: `
                try {
                    operation1();
                } catch (err: any) {
                    const error = toError(err);
                    try {
                        operation2();
                    } catch (e: any) {
                        const error2 = toError(e);
                    }
                }
            `,
            errors: [
                {
                    messageId: 'wrongParameterName',
                    data: { actual: 'e' },
                },
            ],
        },
        // Nested: wrong variable name for error2
        {
            code: `
                try {
                    operation1();
                } catch (err: any) {
                    const error = toError(err);
                    try {
                        operation2();
                    } catch (err2: any) {
                        const err = toError(err2);
                    }
                }
            `,
            errors: [
                {
                    messageId: 'wrongVariableName',
                    data: { expected: 'error2', actual: 'err' },
                },
            ],
        },
        // No parameter at all
        {
            code: `
                try {
                    doSomething();
                } catch {
                    console.log('error');
                }
            `,
            errors: [
                {
                    messageId: 'missingTypeAnnotation',
                },
            ],
        },
        // Variable declared but not initialized
        {
            code: `
                try {
                    doSomething();
                } catch (err: any) {
                    const error;
                }
            `,
            errors: [
                {
                    messageId: 'missingToError',
                },
            ],
        },
        // Using new Error instead of toError
        {
            code: `
                try {
                    doSomething();
                } catch (err: any) {
                    const error = new Error(err.message);
                }
            `,
            errors: [
                {
                    messageId: 'missingToError',
                },
            ],
        },
    ],
});

console.log('✅ All catch-error-pattern rule tests passed!');
