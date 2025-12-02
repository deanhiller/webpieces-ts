import { toError } from '../lib/errorUtils';

describe('toError', () => {
    describe('Error instances', () => {
        it('should return Error instances unchanged', () => {
            const originalError = new Error('Test error');
            const result = toError(originalError);

            expect(result).toBe(originalError);
            expect(result.message).toBe('Test error');
        });

        it('should return custom Error subclasses unchanged', () => {
            class CustomError extends Error {
                constructor(message: string) {
                    super(message);
                    this.name = 'CustomError';
                }
            }

            const originalError = new CustomError('Custom error');
            const result = toError(originalError);

            expect(result).toBe(originalError);
            expect(result.message).toBe('Custom error');
            expect(result.name).toBe('CustomError');
        });
    });

    describe('Error-like objects', () => {
        it('should convert object with message property', () => {
            const errorLike = { message: 'Error message' };
            const result = toError(errorLike);

            expect(result).toBeInstanceOf(Error);
            expect(result.message).toBe('Error message');
        });

        it('should preserve stack trace from error-like object', () => {
            const errorLike = {
                message: 'Error message',
                stack: 'Stack trace here',
            };
            const result = toError(errorLike);

            expect(result.stack).toBe('Stack trace here');
        });

        it('should preserve error name from error-like object', () => {
            const errorLike = {
                message: 'Error message',
                name: 'CustomError',
            };
            const result = toError(errorLike);

            expect(result.name).toBe('CustomError');
        });

        it('should preserve both name and stack', () => {
            const errorLike = {
                message: 'Error message',
                name: 'CustomError',
                stack: 'Custom stack trace',
            };
            const result = toError(errorLike);

            expect(result.message).toBe('Error message');
            expect(result.name).toBe('CustomError');
            expect(result.stack).toBe('Custom stack trace');
        });
    });

    describe('Objects without message', () => {
        it('should stringify simple objects', () => {
            const obj = { code: 404, status: 'Not Found' };
            const result = toError(obj);

            expect(result).toBeInstanceOf(Error);
            expect(result.message).toBe(
                'Non-Error object thrown: {"code":404,"status":"Not Found"}',
            );
        });

        it('should handle objects with circular references', () => {
            const obj: any = { name: 'circular' };
            obj.self = obj;

            const result = toError(obj);

            expect(result).toBeInstanceOf(Error);
            expect(result.message).toBe('Non-Error object thrown (unable to stringify)');
        });

        it('should handle empty objects', () => {
            const result = toError({});

            expect(result).toBeInstanceOf(Error);
            expect(result.message).toBe('Non-Error object thrown: {}');
        });
    });

    describe('Primitive values', () => {
        it('should convert string to Error', () => {
            const result = toError('Error message');

            expect(result).toBeInstanceOf(Error);
            expect(result.message).toBe('Error message');
        });

        it('should convert number to Error', () => {
            const result = toError(404);

            expect(result).toBeInstanceOf(Error);
            expect(result.message).toBe('404');
        });

        it('should convert boolean to Error', () => {
            const result = toError(false);

            expect(result).toBeInstanceOf(Error);
            expect(result.message).toBe('false');
        });

        it('should handle null', () => {
            const result = toError(null);

            expect(result).toBeInstanceOf(Error);
            expect(result.message).toBe('Null or undefined thrown');
        });

        it('should handle undefined', () => {
            const result = toError(undefined);

            expect(result).toBeInstanceOf(Error);
            expect(result.message).toBe('Null or undefined thrown');
        });
    });

    describe('Real-world scenarios', () => {
        it('should handle axios-like error objects', () => {
            const axiosError = {
                message: 'Request failed with status code 404',
                name: 'AxiosError',
                stack: 'Error: Request failed...',
                response: {
                    status: 404,
                    data: { error: 'Not found' },
                },
            };

            const result = toError(axiosError);

            expect(result).toBeInstanceOf(Error);
            expect(result.message).toBe('Request failed with status code 404');
            expect(result.name).toBe('AxiosError');
            expect(result.stack).toBe('Error: Request failed...');
        });

        it('should handle Promise rejection with string', () => {
            const rejection = 'Promise rejected';
            const result = toError(rejection);

            expect(result).toBeInstanceOf(Error);
            expect(result.message).toBe('Promise rejected');
        });

        it('should handle DOM errors in browser context', () => {
            // Simulating a DOM error object
            const domError = {
                message: 'Network request failed',
                name: 'NetworkError',
            };

            const result = toError(domError);

            expect(result).toBeInstanceOf(Error);
            expect(result.message).toBe('Network request failed');
            expect(result.name).toBe('NetworkError');
        });
    });

    describe('Edge cases', () => {
        it('should handle symbol', () => {
            const sym = Symbol('test');
            const result = toError(sym);

            expect(result).toBeInstanceOf(Error);
            expect(result.message).toBe('Symbol(test)');
        });

        it('should handle BigInt', () => {
            const bigInt = BigInt(9007199254740991);
            const result = toError(bigInt);

            expect(result).toBeInstanceOf(Error);
            expect(result.message).toBe('9007199254740991');
        });

        it('should handle function', () => {
            const fn = function testFunction() {};
            const result = toError(fn);

            expect(result).toBeInstanceOf(Error);
            expect(result.message).toContain('function');
        });
    });
});
