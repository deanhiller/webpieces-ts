/**
 * Test to demonstrate Promise.resolve() behavior with synchronous throws
 * vs async rejections - THIS IS WHY WE USE async/await IN MIDDLEWARE
 */

describe('Promise.resolve() vs async/await for error handling', () => {
  describe('Promise.resolve(fn()) - BROKEN for sync throws', () => {
    it('does NOT catch synchronous throws', () => {
      const syncThrow = () => {
        throw new Error('Synchronous throw');
      };

      // This test PROVES Promise.resolve(fn()) doesn't catch sync throws
      expect(() => {
        Promise.resolve(syncThrow()).catch((err) => {
          // This catch handler is NEVER called because the throw
          // happens BEFORE Promise.resolve() is called
          console.log('Caught:', err);
        });
      }).toThrow('Synchronous throw');

      // The error is thrown synchronously, .catch() never gets attached
    });

    it('DOES catch async rejections (but this is not enough)', async () => {
      const asyncReject = () => {
        return Promise.reject(new Error('Async rejection'));
      };

      // This works because asyncReject() RETURNS a rejected promise
      const caughtError = await new Promise((resolve) => {
        Promise.resolve(asyncReject())
          .catch((err) => {
            resolve(err); // Caught successfully
          });
      });

      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toBe('Async rejection');
    });
  });

  describe('async/await - WORKS for both sync throws and async rejections', () => {
    it('catches synchronous throws', async () => {
      const syncThrow = () => {
        throw new Error('Synchronous throw');
      };

      try {
        await syncThrow();
        fail('Should have thrown');
      } catch (err: any) {
        const error = err as Error;
        expect(error.message).toBe('Synchronous throw');
      }
    });

    it('catches async rejections', async () => {
      const asyncReject = () => {
        return Promise.reject(new Error('Async rejection'));
      };

      try {
        await asyncReject();
        fail('Should have thrown');
      } catch (err: any) {
        const error = err as Error;
        expect(error.message).toBe('Async rejection');
      }
    });

    it('catches throws from async functions', async () => {
      const asyncThrow = async () => {
        throw new Error('Throw inside async function');
      };

      try {
        await asyncThrow();
        fail('Should have thrown');
      } catch (err: any) {
        const error = err as Error;
        expect(error.message).toBe('Throw inside async function');
      }
    });
  });

  describe('Promise.resolve().then(() => fn()) - ALTERNATIVE pattern', () => {
    it('catches synchronous throws by wrapping in then()', async () => {
      const syncThrow = () => {
        throw new Error('Synchronous throw');
      };

      // This works because the throw happens INSIDE the .then() callback
      // Promises automatically catch throws inside then/catch/finally callbacks
      const caughtError = await new Promise((resolve) => {
        Promise.resolve()
          .then(() => syncThrow())
          .catch((err) => {
            resolve(err);
          });
      });

      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toBe('Synchronous throw');
    });

    it('also catches async rejections', async () => {
      const asyncReject = () => {
        return Promise.reject(new Error('Async rejection'));
      };

      const caughtError = await new Promise((resolve) => {
        Promise.resolve()
          .then(() => asyncReject())
          .catch((err) => {
            resolve(err);
          });
      });

      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toBe('Async rejection');
    });
  });

  describe('Express middleware implications', () => {
    it('demonstrates why async/await is required for middleware', async () => {
      // Simulate Express next() that can throw synchronously
      const next = () => {
        // In Express 4.x, next() can throw in certain error conditions
        throw new Error('Router not found');
      };

      // BROKEN: Promise.resolve(next()).catch(...)
      let brokenPatternCaught = false;
      try {
        Promise.resolve(next()).catch(() => {
          brokenPatternCaught = true;
        });
        fail('Should have thrown');
      } catch (err: any) {
        const error = err as Error;
        expect(error.message).toBe('Router not found');
        expect(brokenPatternCaught).toBe(false); // .catch() never called!
      }

      // WORKING: async/await pattern
      let workingPatternCaught = false;
      try {
        await next();
      } catch (err: any) {
        const error = err as Error;
        expect(error.message).toBe('Router not found');
        workingPatternCaught = true;
      }
      expect(workingPatternCaught).toBe(true); // Caught successfully!
    });
  });
});
