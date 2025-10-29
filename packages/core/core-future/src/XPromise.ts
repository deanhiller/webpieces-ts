import { Context } from '@webpieces/core-context';

/**
 * XPromise - Context-preserving Promise wrapper.
 * Similar to Java WebPieces XFuture which wraps CompletableFuture.
 *
 * This ensures that request-scoped context (stored in AsyncLocalStorage)
 * is preserved across all async operations, even when callbacks are
 * executed in different execution contexts.
 *
 * Example usage:
 * ```typescript
 * Context.put('REQUEST_ID', '12345');
 *
 * const result = await XPromise.resolve(fetchData())
 *   .thenApply(data => processData(data))
 *   .thenApply(processed => {
 *     const id = Context.get('REQUEST_ID'); // Still available!
 *     return saveData(processed);
 *   });
 * ```
 */
export class XPromise<T> implements Promise<T> {
  private promise: Promise<T>;

  // Required for Promise interface
  readonly [Symbol.toStringTag]: string = 'XPromise';

  constructor(
    executor: (
      resolve: (value: T | PromiseLike<T>) => void,
      reject: (reason?: any) => void
    ) => void
  ) {
    // Capture context at promise creation time
    const savedContext = Context.copyContext();

    this.promise = new Promise<T>((resolve, reject) => {
      // Run executor with saved context
      Context.runWithContext(savedContext, () => {
        executor(resolve, reject);
      });
    });
  }

  /**
   * Create a resolved XPromise.
   */
  static resolve<T>(value: T | PromiseLike<T>): XPromise<T> {
    const savedContext = Context.copyContext();
    return new XPromise<T>((resolve) => {
      Context.runWithContext(savedContext, () => {
        resolve(value);
      });
    });
  }

  /**
   * Create a rejected XPromise.
   */
  static reject<T = never>(reason?: any): XPromise<T> {
    const savedContext = Context.copyContext();
    return new XPromise<T>((_, reject) => {
      Context.runWithContext(savedContext, () => {
        reject(reason);
      });
    });
  }

  /**
   * Wait for all promises to complete.
   */
  static all<T>(values: Iterable<T | PromiseLike<T>>): XPromise<Awaited<T>[]> {
    const savedContext = Context.copyContext();
    return new XPromise<Awaited<T>[]>((resolve, reject) => {
      Context.runWithContext(savedContext, () => {
        Promise.all(values).then(resolve, reject);
      });
    });
  }

  /**
   * Race multiple promises.
   */
  static race<T>(values: Iterable<T | PromiseLike<T>>): XPromise<Awaited<T>> {
    const savedContext = Context.copyContext();
    return new XPromise<Awaited<T>>((resolve, reject) => {
      Context.runWithContext(savedContext, () => {
        Promise.race(values).then(resolve, reject);
      });
    });
  }

  /**
   * Transform the result using a function (similar to Java thenApply).
   * Preserves context across the transformation.
   */
  thenApply<U>(fn: (value: T) => U | PromiseLike<U>): XPromise<U> {
    const savedContext = Context.copyContext();

    return new XPromise<U>((resolve, reject) => {
      this.promise.then(
        (value) => {
          try {
            Context.runWithContext(savedContext, () => {
              const result = fn(value);
              resolve(result);
            });
          } catch (error) {
            reject(error);
          }
        },
        reject
      );
    });
  }

  /**
   * Chain another promise (similar to Java thenCompose).
   * Preserves context across the chain.
   */
  thenCompose<U>(
    fn: (value: T) => XPromise<U> | PromiseLike<U>
  ): XPromise<U> {
    const savedContext = Context.copyContext();

    return new XPromise<U>((resolve, reject) => {
      this.promise.then(
        (value) => {
          try {
            Context.runWithContext(savedContext, () => {
              const result = fn(value);
              if (result instanceof XPromise || result instanceof Promise) {
                result.then(resolve, reject);
              } else {
                resolve(result as any);
              }
            });
          } catch (error) {
            reject(error);
          }
        },
        reject
      );
    });
  }

  /**
   * Handle both success and failure (similar to Java handle).
   * Preserves context.
   */
  handle<U>(
    fn: (value: T | null, error: any | null) => U | PromiseLike<U>
  ): XPromise<U> {
    const savedContext = Context.copyContext();

    return new XPromise<U>((resolve, reject) => {
      this.promise.then(
        (value) => {
          try {
            Context.runWithContext(savedContext, () => {
              const result = fn(value, null);
              resolve(result);
            });
          } catch (error) {
            reject(error);
          }
        },
        (error) => {
          try {
            Context.runWithContext(savedContext, () => {
              const result = fn(null, error);
              resolve(result);
            });
          } catch (handlerError) {
            reject(handlerError);
          }
        }
      );
    });
  }

  /**
   * Standard Promise.then implementation with context preservation.
   */
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): XPromise<TResult1 | TResult2> {
    const savedContext = Context.copyContext();

    const wrappedFulfilled = onfulfilled
      ? (value: T) => {
          return Context.runWithContext(savedContext, () => onfulfilled(value));
        }
      : undefined;

    const wrappedRejected = onrejected
      ? (reason: any) => {
          return Context.runWithContext(savedContext, () => onrejected(reason));
        }
      : undefined;

    return new XPromise<TResult1 | TResult2>((resolve, reject) => {
      this.promise.then(wrappedFulfilled, wrappedRejected).then(resolve, reject);
    });
  }

  /**
   * Standard Promise.catch implementation with context preservation.
   */
  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null
  ): XPromise<T | TResult> {
    const savedContext = Context.copyContext();

    const wrappedRejected = onrejected
      ? (reason: any) => {
          return Context.runWithContext(savedContext, () => onrejected(reason));
        }
      : undefined;

    return new XPromise<T | TResult>((resolve, reject) => {
      this.promise.catch(wrappedRejected).then(resolve, reject);
    });
  }

  /**
   * Standard Promise.finally implementation with context preservation.
   */
  finally(onfinally?: (() => void) | null): XPromise<T> {
    const savedContext = Context.copyContext();

    const wrappedFinally = onfinally
      ? () => {
          return Context.runWithContext(savedContext, () => onfinally());
        }
      : undefined;

    return new XPromise<T>((resolve, reject) => {
      this.promise.finally(wrappedFinally).then(resolve, reject);
    });
  }
}
