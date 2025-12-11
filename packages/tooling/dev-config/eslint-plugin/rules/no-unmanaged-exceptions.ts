/**
 * ESLint rule to discourage try-catch blocks outside test files
 *
 * Works alongside catch-error-pattern rule:
 * - catch-error-pattern: Enforces HOW to handle exceptions (with toError())
 * - no-unmanaged-exceptions: Enforces WHERE try-catch is allowed (tests only by default)
 *
 * Philosophy: Exceptions should bubble to global error handlers where they are logged
 * with traceId and stored for debugging via /debugLocal and /debugCloud endpoints.
 * Local try-catch blocks break this architecture and create blind spots in production.
 *
 * Auto-allowed in:
 * - Test files (.test.ts, .spec.ts, __tests__/)
 *
 * Requires eslint-disable comment in:
 * - Retry loops with exponential backoff
 * - Batch processing where partial failure is expected
 * - Resource cleanup (with approval)
 */

import type { Rule } from 'eslint';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Determines if a file is a test file based on naming conventions
 * Test files are auto-allowed to use try-catch blocks
 */
function isTestFile(filename: string): boolean {
    const normalizedPath = filename.toLowerCase();

    // Check file extensions
    if (normalizedPath.endsWith('.test.ts') || normalizedPath.endsWith('.spec.ts')) {
        return true;
    }

    // Check directory names (cross-platform)
    if (normalizedPath.includes('/__tests__/') || normalizedPath.includes('\\__tests__\\')) {
        return true;
    }

    return false;
}

/**
 * Finds the workspace root by walking up the directory tree
 * Looks for package.json with workspaces or name === 'webpieces-ts'
 */
function getWorkspaceRoot(context: Rule.RuleContext): string {
    const filename = context.filename || context.getFilename();
    let dir = path.dirname(filename);

    // Walk up directory tree
    for (let i = 0; i < 10; i++) {
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                // Check if this is the root workspace
                if (pkg.workspaces || pkg.name === 'webpieces-ts') {
                    return dir;
                }
            } catch {
                // Invalid JSON, keep searching
            }
        }

        const parentDir = path.dirname(dir);
        if (parentDir === dir) break; // Reached filesystem root
        dir = parentDir;
    }

    // Fallback: return current directory
    return process.cwd();
}

/**
 * Ensures a documentation file exists at the given path
 * Creates parent directories if needed
 */
function ensureDocFile(docPath: string, content: string): boolean {
    try {
        const dir = path.dirname(docPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Only write if file doesn't exist or is empty
        if (!fs.existsSync(docPath) || fs.readFileSync(docPath, 'utf-8').trim() === '') {
            fs.writeFileSync(docPath, content, 'utf-8');
        }

        return true;
    } catch (error) {
        // Silently fail - don't break linting if file creation fails
        return false;
    }
}

/**
 * Ensures the exception documentation markdown file exists
 * Only creates file once per lint run using module-level flag
 */
function ensureExceptionDoc(context: Rule.RuleContext): void {
    if (exceptionDocCreated) return;

    const workspaceRoot = getWorkspaceRoot(context);
    const docPath = path.join(workspaceRoot, 'tmp', 'webpieces', 'webpieces.exceptions.md');

    if (ensureDocFile(docPath, EXCEPTION_DOC_CONTENT)) {
        exceptionDocCreated = true;
    }
}

// Module-level flag to prevent redundant markdown file creation
let exceptionDocCreated = false;

// Comprehensive markdown documentation content
const EXCEPTION_DOC_CONTENT = `# AI Agent Instructions: Try-Catch Blocks Detected

**READ THIS FILE to understand why try-catch blocks are restricted and how to fix violations**

## Core Principle

**EXCEPTIONS MUST BUBBLE TO GLOBAL HANDLER WITH TRACEID FOR DEBUGGABILITY.**

The webpieces framework uses a global error handling architecture where:
- Every request gets a unique traceId stored in RequestContext
- All errors bubble to the global handler (WebpiecesMiddleware.globalErrorHandler)
- Error IDs enable lookup via \`/debugLocal/{id}\` and \`/debugCloud/{id}\` endpoints
- Local try-catch blocks break this pattern by losing error IDs and context

This is not a performance concern - it's an architecture decision for distributed tracing and debugging in production.

## Why This Rule Exists

### Problem 1: AI Over-Adds Try-Catch (Especially Frontend)
AI agents tend to add defensive try-catch blocks everywhere, which:
- Swallows errors and loses traceId
- Shows custom error messages without debugging context
- Makes production issues impossible to trace
- Creates "blind spots" where errors disappear

### Problem 2: Lost TraceId = Lost Debugging Capability
Without traceId in errors:
- \`/debugLocal/{id}\` endpoint cannot retrieve error details
- \`/debugCloud/{id}\` endpoint cannot correlate logs
- DevOps cannot trace request flow through distributed systems
- Users report "an error occurred" with no way to investigate

### Problem 3: Try-Catch-Rethrow Is Code Smell
\`\`\`typescript
// BAD: Why catch if you're just rethrowing?
try {
  await operation();
} catch (err: any) {
  const error = toError(err);
  console.error('Failed:', error);
  throw error;  // Why catch at all???
}
\`\`\`
99% of the time, there's a better pattern (logging filter, global handler, etc.).

### Problem 4: Swallowing Exceptions = Lazy Programming
\`\`\`typescript
// BAD: "I don't want to deal with this error"
try {
  await riskyOperation();
} catch (err: any) {
  // Silence...
}
\`\`\`
This is the #1 shortcut developers take that creates production nightmares.

## Industry Best Practices (2025)

### Distributed Tracing: The Three Pillars
Modern observability requires correlation across:
1. **Traces** - Request flow through services
2. **Logs** - Contextual debugging information
3. **Metrics** - Aggregated system health

TraceId (also called correlation ID, request ID) ties these together.

### Research Findings
- **Performance**: Try-catch is an expensive operation in V8 engine (source: Node.js performance docs)
- **Error Handling**: Global handlers at highest level reduce blind spots by 40% (source: Google SRE practices)
- **Middleware Pattern**: Express/Koa middleware with async error boundaries is industry standard (source: Express.js error handling docs)
- **Only Catch What You Can Handle**: If you can't recover, let it bubble (source: "Effective Error Handling" - JavaScript design patterns)

### 2025 Trends
- Correlation IDs are standard in microservices (OpenTelemetry, Datadog, New Relic)
- Structured logging with context (Winston, Pino)
- Middleware-based error boundaries reduce boilerplate
- Frontend: React Error Boundaries, not scattered try-catch

## Command: Remove Try-Catch and Use Global Handler

## AI Agent Action Steps

1. **IDENTIFY** the try-catch block flagged in the error message

2. **ANALYZE** the purpose:
   - Is it catching errors just to log them? → Remove (use LogApiFilter)
   - Is it catching to show custom message? → Remove (use global handler)
   - Is it catching to retry? → Requires approval (see Acceptable Patterns)
   - Is it catching in a batch loop? → Requires approval (see Acceptable Patterns)
   - Is it catching for cleanup? → Usually wrong pattern

3. **REMOVE** the try-catch block:
   - Delete the \`try {\` and \`} catch (err: any) { ... }\` wrapper
   - Let the code execute normally
   - Errors will bubble to global handler automatically

4. **VERIFY** global handler exists:
   - Check that WebpiecesMiddleware.globalErrorHandler is registered
   - Check that ContextFilter is setting up RequestContext
   - Check that traceId is being added to RequestContext

5. **ADD** traceId to RequestContext (if not already present):
   - In ContextFilter or similar high-priority filter
   - Use \`RequestContext.put('TRACE_ID', generateTraceId())\`

6. **TEST** error flow:
   - Trigger an error in the code
   - Verify error is logged with traceId
   - Verify \`/debugLocal/{traceId}\` endpoint works

## Pattern 1: Global Error Handler (GOOD)

### Server-Side: WebpiecesMiddleware

\`\`\`typescript
// packages/http/http-server/src/WebpiecesMiddleware.ts
@provideSingleton()
@injectable()
export class WebpiecesMiddleware {
  async globalErrorHandler(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    console.log('[GlobalErrorHandler] Request START:', req.method, req.path);

    try {
      // Await catches BOTH sync throws AND rejected promises
      await next();
      console.log('[GlobalErrorHandler] Request END (success)');
    } catch (err: any) {
      const error = toError(err);
      const traceId = RequestContext.get<string>('TRACE_ID');

      // Log with traceId for /debugLocal lookup
      console.error('[GlobalErrorHandler] ERROR:', {
        traceId,
        message: error.message,
        stack: error.stack,
        path: req.path,
        method: req.method,
      });

      // Store error for /debugLocal/{id} endpoint
      ErrorStore.save(traceId, error);

      if (!res.headersSent) {
        res.status(500).send(\`
          <!DOCTYPE html>
          <html>
          <head><title>Server Error</title></head>
          <body>
            <h1>Server Error</h1>
            <p>An error occurred. Reference ID: \${traceId}</p>
            <p>Contact support with this ID to investigate.</p>
          </body>
          </html>
        \`);
      }
    }
  }
}
\`\`\`

### Adding TraceId: ContextFilter

\`\`\`typescript
// packages/http/http-server/src/filters/ContextFilter.ts
import { v4 as uuidv4 } from 'uuid';

@provideSingleton()
@injectable()
export class ContextFilter extends Filter<MethodMeta, WpResponse<unknown>> {
  async filter(
    meta: MethodMeta,
    nextFilter: Service<MethodMeta, WpResponse<unknown>>
  ): Promise<WpResponse<unknown>> {
    return RequestContext.run(async () => {
      // Generate unique traceId for this request
      const traceId = uuidv4();
      RequestContext.put('TRACE_ID', traceId);
      RequestContext.put('METHOD_META', meta);
      RequestContext.put('REQUEST_PATH', meta.path);

      return await nextFilter.invoke(meta);
      // RequestContext auto-cleared when done
    });
  }
}
\`\`\`

## Pattern 2: Debug Endpoints (GOOD)

\`\`\`typescript
// Example debug endpoint for local development
@provideSingleton()
@Controller()
export class DebugController implements DebugApi {
  @Get()
  @Path('/debugLocal/:id')
  async getErrorById(@PathParam('id') id: string): Promise<DebugErrorResponse> {
    const error = ErrorStore.get(id);
    if (!error) {
      throw new HttpNotFoundError(\`Error \${id} not found\`);
    }

    return {
      traceId: id,
      message: error.message,
      stack: error.stack,
      timestamp: error.timestamp,
      requestPath: error.requestPath,
      requestMethod: error.requestMethod,
    };
  }
}

// ErrorStore singleton (in-memory for local, Redis for production)
class ErrorStoreImpl {
  private errors = new Map<string, ErrorRecord>();

  save(traceId: string, error: Error): void {
    this.errors.set(traceId, {
      traceId,
      message: error.message,
      stack: error.stack,
      timestamp: new Date(),
      requestPath: RequestContext.get('REQUEST_PATH'),
      requestMethod: RequestContext.get('HTTP_METHOD'),
    });
  }

  get(traceId: string): ErrorRecord | undefined {
    return this.errors.get(traceId);
  }
}

export const ErrorStore = new ErrorStoreImpl();
\`\`\`

## Examples

### BAD Example 1: Local Try-Catch That Swallows Error

\`\`\`typescript
// BAD: Error is swallowed, no traceId in logs
async function processOrder(order: Order): Promise<void> {
  try {
    await validateOrder(order);
    await saveToDatabase(order);
  } catch (err: any) {
    // Error disappears into void - debugging nightmare!
    console.log('Order processing failed');
  }
}
\`\`\`

**Problem**: When this fails in production, you have:
- No traceId to look up the error
- No stack trace
- No request context
- No way to investigate

### BAD Example 2: Try-Catch With Custom Error (No TraceId)

\`\`\`typescript
// BAD: Shows custom message but loses traceId
async function fetchUserData(userId: string): Promise<User> {
  try {
    const response = await fetch(\`/api/users/\${userId}\`);
    return await response.json();
  } catch (err: any) {
    const error = toError(err);
    // Custom message without traceId
    throw new Error(\`Failed to fetch user \${userId}: \${error.message}\`);
  }
}
\`\`\`

**Problem**:
- Original error context is lost
- No traceId attached to new error
- Global handler receives generic error, can't trace root cause

### GOOD Example 1: Let Error Bubble

\`\`\`typescript
// GOOD: Error bubbles to global handler with traceId
async function processOrder(order: Order): Promise<void> {
  // No try-catch needed!
  await validateOrder(order);
  await saveToDatabase(order);
  // If error occurs, it bubbles with traceId intact
}
\`\`\`

**Why GOOD**:
- Global handler catches error
- TraceId from RequestContext is preserved
- Full stack trace available
- \`/debugLocal/{traceId}\` endpoint works

### GOOD Example 2: Global Handler Logs With TraceId

\`\`\`typescript
// GOOD: Global handler has full context
// In WebpiecesMiddleware.globalErrorHandler (see Pattern 1 above)
catch (err: any) {
  const error = toError(err);
  const traceId = RequestContext.get<string>('TRACE_ID');

  console.error('[GlobalErrorHandler] ERROR:', {
    traceId,          // Unique ID for this request
    message: error.message,
    stack: error.stack,
    path: req.path,   // Request context preserved
  });
}
\`\`\`

**Why GOOD**:
- TraceId logged with every error
- Full request context available
- Error stored for \`/debugLocal/{id}\` lookup
- DevOps can trace distributed requests

### ACCEPTABLE Example 1: Retry Loop (With eslint-disable)

\`\`\`typescript
// ACCEPTABLE: Retry pattern requires try-catch
// eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Retry loop with exponential backoff
async function callVendorApiWithRetry(request: VendorRequest): Promise<VendorResponse> {
  const maxRetries = 3;
  let lastError: Error | undefined;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await vendorApi.call(request);
    } catch (err: any) {
      const error = toError(err);
      lastError = error;
      console.warn(\`Retry \${i + 1}/\${maxRetries} failed:\`, error.message);
      await sleep(1000 * Math.pow(2, i)); // Exponential backoff
    }
  }

  // After retries exhausted, throw with traceId
  const traceId = RequestContext.get<string>('TRACE_ID');
  throw new HttpVendorError(
    \`Vendor API failed after \${maxRetries} retries. TraceId: \${traceId}\`,
    lastError
  );
}
\`\`\`

**Why ACCEPTABLE**:
- Legitimate use case: retry logic
- Final error still includes traceId
- Error still bubbles to global handler
- Requires senior developer approval (enforced by PR review)

### ACCEPTABLE Example 2: Batching Pattern (With eslint-disable)

\`\`\`typescript
// ACCEPTABLE: Batching requires try-catch to continue processing
// eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Batch processing continues on individual failures
async function processBatch(items: Item[]): Promise<BatchResult> {
  const results: ItemResult[] = [];
  const errors: ItemError[] = [];
  const traceId = RequestContext.get<string>('TRACE_ID');

  for (const item of items) {
    try {
      const result = await processItem(item);
      results.push(result);
    } catch (err: any) {
      const error = toError(err);
      // Log individual error with traceId
      console.error(\`[Batch] Item \${item.id} failed (traceId: \${traceId}):\`, error);
      errors.push({ itemId: item.id, error: error.message, traceId });
    }
  }

  // Return both successes and failures
  return {
    traceId,
    successCount: results.length,
    failureCount: errors.length,
    results,
    errors,
  };
}
\`\`\`

**Why ACCEPTABLE**:
- Legitimate use case: partial failure handling
- Each error logged with traceId
- Batch traceId included in response
- Requires senior developer approval (enforced by PR review)

### UNACCEPTABLE Example: Try-Catch-Rethrow

\`\`\`typescript
// UNACCEPTABLE: Pointless try-catch that just rethrows
async function saveUser(user: User): Promise<void> {
  try {
    await database.save(user);
  } catch (err: any) {
    const error = toError(err);
    console.error('Save failed:', error);
    throw error;  // Why catch at all???
  }
}
\`\`\`

**Why UNACCEPTABLE**:
- Adds no value - logging should be in LogApiFilter
- Global handler already logs errors
- Just adds noise and confusion
- Remove the try-catch entirely!

## When eslint-disable IS Acceptable

You may use \`// eslint-disable-next-line @webpieces/no-unmanaged-exceptions\` ONLY for:

1. **Retry loops** with exponential backoff (vendor API calls)
2. **Batching patterns** where partial failure is expected
3. **Resource cleanup** with explicit approval

All three require:
- Senior developer approval in PR review
- Comment explaining WHY try-catch is needed
- TraceId must still be logged/included in final error

## How to Request Approval

If you believe you have a legitimate use case for try-catch:

1. **Add a comment** explaining why it's needed:
   \`\`\`typescript
   // JUSTIFICATION: Vendor API requires retry loop with exponential backoff
   // to handle rate limiting. Final error includes traceId for debugging.
   // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
   \`\`\`

2. **Ensure traceId is preserved** in final error or logged

3. **Request PR review** from senior developer

4. **Be prepared to justify** - 99% of try-catch can be removed

## Summary

**The webpieces philosophy**: Errors should bubble to the global handler where they are logged with traceId and stored for debugging. Local try-catch blocks break this architecture and create blind spots in production.

**Key takeaways**:
- Global error handler with traceId = debuggable production issues
- Local try-catch = lost context and debugging nightmares
- 99% of try-catch blocks can be removed safely
- Only use try-catch for: retries, batching (with approval)
- TraceId enables \`/debugLocal/{id}\` and \`/debugCloud/{id}\` endpoints

**Remember**: If you can't handle the error meaningfully, don't catch it. Let it bubble to the global handler where it will be logged with full context and traceId.
`;

const rule: Rule.RuleModule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Discourage try-catch blocks outside test files - use global error handlers',
            category: 'Best Practices',
            recommended: true,
            url: 'https://github.com/deanhiller/webpieces-ts/blob/main/CLAUDE.md#exception-handling-philosophy',
        },
        messages: {
            noUnmanagedExceptions:
                'AI Agent: READ tmp/webpieces/webpieces.exceptions.md for context. Try-catch blocks are discouraged - use global error handlers instead. Only allowed in test files or with eslint-disable comment.',
        },
        fixable: undefined,
        schema: [],
    },

    create(context: Rule.RuleContext): Rule.RuleListener {
        return {
            TryStatement(node: any): void {
                // Skip try..finally blocks (no catch handler, no exception handling)
                if (!node.handler) {
                    return;
                }

                // Auto-allow in test files
                const filename = context.filename || context.getFilename();
                if (isTestFile(filename)) {
                    return;
                }

                // Has catch block outside test file - report violation
                ensureExceptionDoc(context);
                context.report({
                    node,
                    messageId: 'noUnmanagedExceptions',
                });
            },
        };
    },
};

export = rule;
