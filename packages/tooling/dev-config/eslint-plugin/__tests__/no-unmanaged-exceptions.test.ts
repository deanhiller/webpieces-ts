/**
 * Tests for no-unmanaged-exceptions ESLint rule
 *
 * Validates that try-catch blocks are:
 * - Auto-allowed in test files (.test.ts, .spec.ts, __tests__/)
 * - Allowed with eslint-disable comment
 * - Disallowed in production code without approval
 */

import { RuleTester } from 'eslint';
import rule from '../rules/no-unmanaged-exceptions';

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

ruleTester.run('no-unmanaged-exceptions', rule, {
    valid: [
        // ============================================
        // Test files - auto-allowed
        // ============================================
        {
            code: `
                try {
                    await operation();
                } catch (err: any) {
                    const error = toError(err);
                    expect(error).toBeDefined();
                }
            `,
            filename: 'SaveController.test.ts',
        },
        {
            code: `
                try {
                    await controller.save(request);
                    fail('Should have thrown');
                } catch (err: any) {
                    const error = toError(err);
                    expect(error.message).toContain('Invalid');
                }
            `,
            filename: 'packages/http/http-server/src/SaveController.test.ts',
        },

        // Spec files - auto-allowed
        {
            code: `
                try {
                    await operation();
                } catch (err: any) {
                    const error = toError(err);
                }
            `,
            filename: 'userService.spec.ts',
        },
        {
            code: `
                it('should throw error', async () => {
                    try {
                        await service.process();
                        fail();
                    } catch (err: any) {
                        const error = toError(err);
                        expect(error).toBeDefined();
                    }
                });
            `,
            filename: 'packages/services/user/userService.spec.ts',
        },

        // __tests__ directory - auto-allowed (need full path)
        {
            code: `
                try {
                    await operation();
                } catch (err: any) {
                    const error = toError(err);
                }
            `,
            filename: '/project/__tests__/integration.ts',
        },
        {
            code: `
                try {
                    await runIntegrationTest();
                } catch (err: any) {
                    const error = toError(err);
                    console.error(error);
                }
            `,
            filename: '/project/packages/http/__tests__/server-integration.ts',
        },
        {
            code: `
                try {
                    const result = performAction();
                } catch (err: any) {
                    const error = toError(err);
                }
            `,
            filename: '/project/src/__tests__/helpers/testUtils.ts',
        },

        // ============================================
        // Code without try-catch (preferred pattern)
        // ============================================
        {
            code: `
                async function processOrder(order: Order): Promise<void> {
                    await validateOrder(order);
                    await saveToDatabase(order);
                }
            `,
            filename: 'OrderService.ts',
        },
        {
            code: `
                export class SaveController {
                    async save(request: SaveRequest): Promise<SaveResponse> {
                        const result = await this.service.save(request);
                        return result;
                    }
                }
            `,
            filename: 'packages/http/http-server/src/SaveController.ts',
        },

        // ============================================
        // Nested functions without try-catch
        // ============================================
        {
            code: `
                function outer() {
                    function inner() {
                        return doSomething();
                    }
                    return inner();
                }
            `,
            filename: 'Utils.ts',
        },
    ],

    invalid: [
        // ============================================
        // Controllers without approval
        // ============================================
        {
            code: `
                try {
                    await operation();
                } catch (err: any) {
                    const error = toError(err);
                }
            `,
            filename: 'SaveController.ts',
            errors: [{ messageId: 'noUnmanagedExceptions' }],
        },
        {
            code: `
                export class SaveController {
                    async save(request: SaveRequest): Promise<SaveResponse> {
                        try {
                            const result = await this.service.save(request);
                            return result;
                        } catch (err: any) {
                            const error = toError(err);
                            throw error;
                        }
                    }
                }
            `,
            filename: 'packages/http/http-server/src/SaveController.ts',
            errors: [{ messageId: 'noUnmanagedExceptions' }],
        },

        // ============================================
        // Services without approval
        // ============================================
        {
            code: `
                try {
                    await this.database.query(sql);
                } catch (err: any) {
                    const error = toError(err);
                }
            `,
            filename: 'UserService.ts',
            errors: [{ messageId: 'noUnmanagedExceptions' }],
        },
        {
            code: `
                export class UserService {
                    async getUserById(id: string): Promise<User> {
                        try {
                            const user = await this.db.findOne({ id });
                            return user;
                        } catch (err: any) {
                            const error = toError(err);
                            console.error('Failed to fetch user:', error);
                            return null;
                        }
                    }
                }
            `,
            filename: 'packages/services/user/UserService.ts',
            errors: [{ messageId: 'noUnmanagedExceptions' }],
        },

        // ============================================
        // Filters without approval
        // ============================================
        {
            code: `
                try {
                    return JSON.parse(body);
                } catch (err: any) {
                    const error = toError(err);
                }
            `,
            filename: 'JsonFilter.ts',
            errors: [{ messageId: 'noUnmanagedExceptions' }],
        },
        {
            code: `
                export class LogFilter implements Filter {
                    async filter(meta: MethodMeta, next: NextFilter): Promise<Action> {
                        try {
                            return await next.execute();
                        } catch (err: any) {
                            const error = toError(err);
                            console.error('Filter error:', error);
                            throw error;
                        }
                    }
                }
            `,
            filename: 'packages/http/http-server/src/filters/LogFilter.ts',
            errors: [{ messageId: 'noUnmanagedExceptions' }],
        },

        // ============================================
        // Utility functions without approval
        // ============================================
        {
            code: `
                async function fetchData(url: string): Promise<Data> {
                    try {
                        const response = await fetch(url);
                        return await response.json();
                    } catch (err: any) {
                        const error = toError(err);
                        throw new Error(\`Fetch failed: \${error.message}\`);
                    }
                }
            `,
            filename: 'packages/core/core-util/src/httpUtils.ts',
            errors: [{ messageId: 'noUnmanagedExceptions' }],
        },

        // ============================================
        // Multiple try-catch blocks in one file
        // ============================================
        {
            code: `
                async function operation1() {
                    try {
                        await doSomething();
                    } catch (err: any) {
                        const error = toError(err);
                    }
                }

                async function operation2() {
                    try {
                        await doSomethingElse();
                    } catch (err: any) {
                        const error = toError(err);
                    }
                }
            `,
            filename: 'MultipleOperations.ts',
            errors: [
                { messageId: 'noUnmanagedExceptions' },
                { messageId: 'noUnmanagedExceptions' },
            ],
        },

        // ============================================
        // Nested try-catch blocks
        // ============================================
        {
            code: `
                try {
                    try {
                        await operation();
                    } catch (err2: any) {
                        const error2 = toError(err2);
                    }
                } catch (err: any) {
                    const error = toError(err);
                }
            `,
            filename: 'NestedOperations.ts',
            errors: [
                { messageId: 'noUnmanagedExceptions' },
                { messageId: 'noUnmanagedExceptions' },
            ],
        },

        // ============================================
        // Try-catch in arrow functions
        // ============================================
        {
            code: `
                const handler = async () => {
                    try {
                        await doSomething();
                    } catch (err: any) {
                        const error = toError(err);
                    }
                };
            `,
            filename: 'Handlers.ts',
            errors: [{ messageId: 'noUnmanagedExceptions' }],
        },

        // ============================================
        // Try-catch in class methods
        // ============================================
        {
            code: `
                export class DataProcessor {
                    process(data: Data): Result {
                        try {
                            return this.performProcessing(data);
                        } catch (err: any) {
                            const error = toError(err);
                            return null;
                        }
                    }
                }
            `,
            filename: 'packages/processors/DataProcessor.ts',
            errors: [{ messageId: 'noUnmanagedExceptions' }],
        },
    ],
});

console.log('All no-unmanaged-exceptions tests passed!');
