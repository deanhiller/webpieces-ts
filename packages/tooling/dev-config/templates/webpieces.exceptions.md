# AI Agent Instructions: Try-Catch Blocks Detected

**READ THIS FILE to understand why try-catch blocks are restricted and how to fix violations**

## GETTING STARTED: Rolling Out This Rule

**Why this rule exists**: AI agents tend to randomly add try-catch blocks ~50% of the time, creating pointless error handling that swallows exceptions and breaks debugging.

**How to roll out on existing codebases**:
1. Enable the rule: `'@webpieces/no-unmanaged-exceptions': 'error'`
2. Have AI add `// eslint-disable-next-line @webpieces/no-unmanaged-exceptions` to EACH try-catch line (NOT file-level disables)
3. This forces AI to consciously acknowledge each exception handling location
4. Going forward, the rule makes AI think twice before adding new try-catch blocks

**What the global error handler provides** (when exceptions bubble up properly):
1. **Logs it** - Full error with stack trace and traceId
2. **Reports to operations** - Sends to monitoring (Sentry/Datadog) so AI/team can fix
3. **Shows user-friendly error** - Pops error dialog with errorId (user receives email with same ID for support)

**Per-line disables are intentional**: Each disable comment serves as documentation explaining WHY that specific try-catch exists, making code review and future AI sessions aware of the exception handling decision.

## Core Principle

**EXCEPTIONS MUST BUBBLE TO GLOBAL HANDLER WITH TRACEID FOR DEBUGGABILITY.**

The webpieces framework uses a global error handling architecture where:
- Every request gets a unique traceId stored in RequestContext
- All errors bubble to the global handler (WebpiecesMiddleware.globalErrorHandler)
- Error IDs enable lookup via `/debugLocal/{id}` and `/debugCloud/{id}` endpoints
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
- `/debugLocal/{id}` endpoint cannot retrieve error details
- `/debugCloud/{id}` endpoint cannot correlate logs
- DevOps cannot trace request flow through distributed systems
- Users report "an error occurred" with no way to investigate

### Problem 3: Pointless Try-Catch-Rethrow
```typescript
// BAD: Catching just to rethrow without adding value
try {
  await operation();
} catch (err: any) {
  const error = toError(err);
  console.error('Failed:', error);
  throw error;  // No new info added - why catch?
}
```

**However, try-catch-rethrow IS acceptable when:**
1. **Adding context to the error**: `throw new Error("Failed to process order #123", { cause: error })`
2. **Edge code logging** (see "Edge Code Patterns" section below)

The key question: Are you adding meaningful information or context? If yes, it may be valid.

### Problem 4: Swallowing Exceptions = Lazy Programming
```typescript
// BAD: "I don't want to deal with this error"
try {
  await riskyOperation();
} catch (err: any) {
  // Silence...
}
```
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

2. **ANALYZE** the purpose and ASK USER if needed:
   - Is it catching errors just to log them? → Remove (use LogApiFilter)
   - Is it catching to show custom message? → Remove (use global handler)
   - Is it catching to retry? → Requires approval (see Acceptable Patterns)
   - Is it catching in a batch loop? → Requires approval (see Acceptable Patterns)
   - Is it catching for cleanup? → Usually wrong pattern
   - **Is this a global entry point?** → **ASK USER**: "I think this code is the entry point where we need a global try-catch block. Is this correct?" (95% of the time it is NOT!)
   - **Is this edge code calling external services?** → **ASK USER**: "This looks like edge code calling an external service. Should I add request/response logging with try-catch?"
   - **Is this form error handling?** → Valid IF: catches only `HttpUserError` for display AND rethrows other errors (see Form Error Handling Pattern)
   - Is it adding context to the error before rethrowing? → May be valid (see Problem 3)

3. **IF REMOVING** the try-catch block:
   - Delete the `try {` and `} catch (err: any) { ... }` wrapper
   - Let the code execute normally
   - Errors will bubble to global handler automatically

4. **IF KEEPING** (after user approval):
   - Add eslint-disable comment with justification
   - Ensure traceId is logged/preserved
   - Follow patterns in "Global Try-Catch Entry Points" or "Edge Code Patterns" sections

5. **VERIFY** global handler exists:
   - Check that WebpiecesMiddleware.globalErrorHandler is registered
   - Check that ContextFilter is setting up RequestContext
   - Check that traceId is being added to RequestContext

6. **ADD** traceId to RequestContext (if not already present):
   - In ContextFilter or similar high-priority filter
   - Use `RequestContext.put('TRACE_ID', generateTraceId())`

7. **TEST** error flow:
   - Trigger an error in the code
   - Verify error is logged with traceId
   - Verify `/debugLocal/{traceId}` endpoint works

## Pattern 1: Global Error Handler (GOOD)

### Server-Side: WebpiecesMiddleware

```typescript
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
        res.status(500).send(`
          <!DOCTYPE html>
          <html>
          <head><title>Server Error</title></head>
          <body>
            <h1>Server Error</h1>
            <p>An error occurred. Reference ID: ${traceId}</p>
            <p>Contact support with this ID to investigate.</p>
          </body>
          </html>
        `);
      }
    }
  }
}
```

### Adding TraceId: ContextFilter

```typescript
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
```

## Pattern 2: Debug Endpoints (GOOD)

```typescript
// Example debug endpoint for local development
@provideSingleton()
@Controller()
export class DebugController implements DebugApi {
  @Get()
  @Path('/debugLocal/:id')
  async getErrorById(@PathParam('id') id: string): Promise<DebugErrorResponse> {
    const error = ErrorStore.get(id);
    if (!error) {
      throw new HttpNotFoundError(`Error ${id} not found`);
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
```

## Examples

### BAD Example 1: Local Try-Catch That Swallows Error

```typescript
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
```

**Problem**: When this fails in production, you have:
- No traceId to look up the error
- No stack trace
- No request context
- No way to investigate

### BAD Example 2: Try-Catch With Custom Error (No TraceId)

```typescript
// BAD: Shows custom message but loses traceId
async function fetchUserData(userId: string): Promise<User> {
  try {
    const response = await fetch(`/api/users/${userId}`);
    return await response.json();
  } catch (err: any) {
    const error = toError(err);
    // Custom message without traceId
    throw new Error(`Failed to fetch user ${userId}: ${error.message}`);
  }
}
```

**Problem**:
- Original error context is lost
- No traceId attached to new error
- Global handler receives generic error, can't trace root cause

### GOOD Example 1: Let Error Bubble

```typescript
// GOOD: Error bubbles to global handler with traceId
async function processOrder(order: Order): Promise<void> {
  // No try-catch needed!
  await validateOrder(order);
  await saveToDatabase(order);
  // If error occurs, it bubbles with traceId intact
}
```

**Why GOOD**:
- Global handler catches error
- TraceId from RequestContext is preserved
- Full stack trace available
- `/debugLocal/{traceId}` endpoint works

### GOOD Example 2: Global Handler Logs With TraceId

```typescript
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
```

**Why GOOD**:
- TraceId logged with every error
- Full request context available
- Error stored for `/debugLocal/{id}` lookup
- DevOps can trace distributed requests

### ACCEPTABLE Example 1: Retry Loop (With eslint-disable)

```typescript
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
      console.warn(`Retry ${i + 1}/${maxRetries} failed:`, error.message);
      await sleep(1000 * Math.pow(2, i)); // Exponential backoff
    }
  }

  // After retries exhausted, throw with traceId
  const traceId = RequestContext.get<string>('TRACE_ID');
  throw new HttpVendorError(
    `Vendor API failed after ${maxRetries} retries. TraceId: ${traceId}`,
    lastError
  );
}
```

**Why ACCEPTABLE**:
- Legitimate use case: retry logic
- Final error still includes traceId
- Error still bubbles to global handler
- Requires senior developer approval (enforced by PR review)

### ACCEPTABLE Example 2: Batching Pattern (With eslint-disable)

```typescript
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
      console.error(`[Batch] Item ${item.id} failed (traceId: ${traceId}):`, error);
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
```

**Why ACCEPTABLE**:
- Legitimate use case: partial failure handling
- Each error logged with traceId
- Batch traceId included in response
- Requires senior developer approval (enforced by PR review)

### UNACCEPTABLE Example: Pointless Try-Catch-Rethrow (Internal Code)

```typescript
// UNACCEPTABLE: Pointless try-catch in INTERNAL code
async function saveUser(user: User): Promise<void> {
  try {
    await userRepository.save(user);  // Internal call, not edge
  } catch (err: any) {
    const error = toError(err);
    console.error('Save failed:', error);
    throw error;  // No value added - why catch?
  }
}
```

**Why UNACCEPTABLE for internal code**:
- Adds no value - logging should be in LogApiFilter
- Global handler already logs errors
- Just adds noise and confusion
- Remove the try-catch entirely!

**CONTRAST with edge code (ACCEPTABLE)**:
```typescript
// ACCEPTABLE: Edge code calling external database service
// eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Edge code: database logging
async function saveUserToDb(user: User): Promise<void> {
  const traceId = RequestContext.get<string>('TRACE_ID');
  try {
    logRequest('[DB] Saving user', { traceId, userId: user.id });
    await externalDbClient.save('users', user);  // EDGE: external service
    logSuccess('[DB] User saved', { traceId, userId: user.id });
  } catch (err: any) {
    const error = toError(err);
    logFailure('[DB] Save failed', { traceId, userId: user.id, error: error.message });
    throw error;  // Rethrow - logging value at the edge
  }
}
```

**The difference**: Edge code benefits from request/response/failure logging at the service boundary. Internal code does not.

## When eslint-disable IS Acceptable

You may use `// eslint-disable-next-line @webpieces/no-unmanaged-exceptions` ONLY for:

1. **Retry loops** with exponential backoff (vendor API calls)
2. **Batching patterns** where partial failure is expected
3. **Resource cleanup** with explicit approval
4. **Global error handler entry points** (see below)
5. **Edge code patterns** for vendor/external service calls (see below)
6. **Form error handling** - catching `HttpUserError` for display, rethrowing others (see below)

All require:
- Comment explaining WHY try-catch is needed
- TraceId must still be logged/included in final error (or error must be rethrown)

## Global Try-Catch Entry Points (MUST ASK USER)

**CRITICAL: 95% of the time, the code you're looking at is NOT a global entry point!**

Before adding a global try-catch, **AI agents MUST ask the user**: "I think this code is the entry point where we need a global try-catch block. Is this correct?"

### Examples of LEGITIMATE Global Error Handlers

These are the rare places where global try-catch IS correct:

1. **Node.js/Express middleware** (at the TOP, after setting up traceId in context):
```typescript
// eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Global error handler entry point
app.use(async (req, res, next) => {
  // First: set up traceId in RequestContext
  const traceId = uuidv4();
  RequestContext.put('TRACE_ID', traceId);

  try {
    await next();
  } catch (err: any) {
    const error = toError(err);
    // Report to Sentry/observability
    Sentry.captureException(error, { extra: { traceId } });
    res.status(500).json({ error: 'Internal error', traceId });
  }
});
```

2. **RxJS global error handler**:
```typescript
// eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- RxJS global unhandled error hook
config.onUnhandledError = (err: any) => {
  const error = toError(err);
  Sentry.captureException(error);
  console.error('[RxJS Unhandled]', error);
};
```

3. **Browser window unhandled promise rejection**:
```typescript
// eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Browser global unhandled promise handler
window.addEventListener('unhandledrejection', (event) => {
  const error = toError(event.reason);
  Sentry.captureException(error);
  console.error('[Unhandled Promise]', error);
});
```

4. **Angular ErrorHandler** (may need try-catch to prevent double recording):
```typescript
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Angular global error handler
  handleError(error: any): void {
    try {
      Sentry.captureException(error);
    } catch (sentryError) {
      // Prevent infinite loop if Sentry itself fails
      console.error('[Sentry failed]', sentryError);
    }
    console.error('[Angular Error]', error);
  }
}
```

5. **3rd party vendor event listeners**:
```typescript
// eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Vendor callback error boundary
vendorSdk.on('event', async (data) => {
  try {
    await processVendorEvent(data);
  } catch (err: any) {
    const error = toError(err);
    const traceId = RequestContext.get<string>('TRACE_ID');
    Sentry.captureException(error, { extra: { traceId, vendorData: data } });
    // Don't rethrow - vendor SDK may not handle errors gracefully
  }
});
```

**All global handlers should report to observability (Sentry, Datadog, etc.) in production.**

## Edge Code Patterns (MUST ASK USER)

Edge code is code that interacts with external systems (vendors, APIs, databases, email services, etc.). These often benefit from a try-catch pattern for **logging the full request/response cycle**.

**AI agents MUST ask the user** before adding edge code try-catch: "This looks like edge code calling an external service. Should I add request/response logging with try-catch?"

### Example: sendMail Pattern
```typescript
// eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Edge code: external email service logging
async function sendMail(request: MailRequest): Promise<MailResponse> {
  const traceId = RequestContext.get<string>('TRACE_ID');

  try {
    logRequest('[Email] Sending', { traceId, to: request.to, subject: request.subject });
    const response = await emailService.send(request);
    logSuccess('[Email] Sent', { traceId, messageId: response.messageId });
    return response;
  } catch (err: any) {
    const error = toError(err);
    logFailure('[Email] Failed', { traceId, error: error.message, to: request.to });
    throw error;  // Rethrow - adds logging value at the edge
  }
}
```

### Why This Pattern Is Valuable at Edges

1. **Complete audit trail**: Request logged, then either success OR failure logged
2. **Vendor debugging**: When vendor says "we never received it", you have proof
3. **Performance monitoring**: Track timing at service boundaries
4. **Correlation**: TraceId connects this edge call to the overall request

### Where Edge Code Patterns Apply

- HTTP client calls to external APIs
- Database operations (especially writes)
- Message queue publish/consume
- Email/SMS/notification services
- Payment gateway calls
- File storage operations (S3, GCS, etc.)
- Any call leaving your service boundary

## Form Error Handling Pattern (Client-Side)

Frontend forms often need to catch user-facing errors (like validation errors) to display in the UI, while rethrowing unexpected errors to the global handler.

**This pattern is ACCEPTABLE because**:
- It catches ONLY user-facing errors (`HttpUserError`) for display
- Unexpected errors are RETHROWN (not swallowed)
- Server throws `HttpUserError` → protocol translates to error payload → client translates back to exception

### Example: Form Submission Error Handling
```typescript
// eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Form error display: catch user errors, rethrow others
async submitForm(): Promise<void> {
  try {
    await this.apiClient.saveData(this.formData);
    this.router.navigate(['/success']);
  } catch (err: any) {
    const error = toError(err);

    if (error instanceof HttpUserError) {
      // User-facing error - display in form
      this.formError = error.message;
      this.cdr.detectChanges();
    } else {
      // Unexpected error - let global handler deal with it
      throw error;
    }
  }
}
```

### Why This Pattern Is Valid

1. **Selective catching**: Only catches errors meant for user display
2. **No swallowing**: Unexpected errors bubble to global handler with traceId
3. **Protocol design**: Server intentionally throws `HttpUserError` for user-facing messages
4. **UX requirement**: Forms must show validation errors inline, not via global error page

### Key Requirements

- **ONLY catch specific error types** (e.g., `HttpUserError`, `ValidationError`)
- **ALWAYS rethrow** errors that aren't user-facing
- The server-side code should throw `HttpUserError` for user-displayable messages

## How to Request Approval

If you believe you have a legitimate use case for try-catch:

1. **Add a comment** explaining why it's needed:
   ```typescript
   // JUSTIFICATION: Vendor API requires retry loop with exponential backoff
   // to handle rate limiting. Final error includes traceId for debugging.
   // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
   ```

2. **Ensure traceId is preserved** in final error or logged

3. **Request PR review** from senior developer

4. **Be prepared to justify** - 99% of try-catch can be removed

## Summary

**The webpieces philosophy**: Errors should bubble to the global handler where they are logged with traceId and stored for debugging. Local try-catch blocks break this architecture and create blind spots in production.

**Key takeaways**:
- Global error handler with traceId = debuggable production issues
- Local try-catch in internal code = lost context and debugging nightmares
- 95% of try-catch blocks can be removed safely
- Acceptable try-catch uses: retries, batching, global entry points, edge code
- **AI agents MUST ask user** before adding global try-catch or edge code patterns
- TraceId enables `/debugLocal/{id}` and `/debugCloud/{id}` endpoints

**Acceptable patterns (with eslint-disable)**:
1. **Global entry points**: Express middleware, RxJS error hooks, Angular ErrorHandler, browser unhandledrejection
2. **Edge code**: External API calls, database operations, email services - use logRequest/logSuccess/logFailure pattern
3. **Retry loops**: Vendor APIs with exponential backoff
4. **Batching**: Partial failure handling where processing must continue
5. **Form error handling**: Catch `HttpUserError` for UI display, rethrow all other errors

**Remember**: If you can't handle the error meaningfully, don't catch it. Let it bubble to the global handler where it will be logged with full context and traceId.

