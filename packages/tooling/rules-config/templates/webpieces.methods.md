# AI Agent Instructions: Method Too Long

**READ THIS FILE to fix methods that are too long**

## Core Principle
Every method should read like a TABLE OF CONTENTS of a book.
- Each method call is a "chapter"
- When you dive into a method, you find another table of contents
- Keeping methods under 70 lines is achievable with proper extraction

## Command: Extract Code into Named Methods

### Pattern 1: Extract Loop Bodies
```typescript
// BAD: 50 lines embedded in loop
for (const order of orders) {
  // 20 lines of validation logic
  // 15 lines of processing logic
  // 10 lines of notification logic
}

// GOOD: Extracted to named methods
for (const order of orders) {
  validateOrder(order);
  processOrderItems(order);
  sendNotifications(order);
}
```

### Pattern 2: Try-Catch Wrapper for Exception Handling
```typescript
// GOOD: Separates success path from error handling
async function handleRequest(req: Request): Promise<Response> {
  // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
  try {
    return await executeRequest(req);
  } catch (err: unknown) {
    const error = toError(err);
    return createErrorResponse(error);
  }
}
```

### Pattern 3: Sequential Method Calls (Table of Contents)
```typescript
// GOOD: Self-documenting steps
function processOrder(order: Order): void {
  validateOrderData(order);
  calculateTotals(order);
  applyDiscounts(order);
  processPayment(order);
  updateInventory(order);
  sendConfirmation(order);
}
```

### Pattern 4: Separate Data Object Creation
```typescript
// BAD: 15 lines of inline object creation
doSomething({ field1: ..., field2: ..., field3: ..., /* 15 more fields */ });

// GOOD: Extract to factory method
const request = createRequestObject(data);
doSomething(request);
```

### Pattern 5: Extract Inline Logic to Named Functions
```typescript
// BAD: Complex inline logic
if (user.role === 'admin' && user.permissions.includes('write') && !user.suspended) {
  // 30 lines of admin logic
}

// GOOD: Extract to named methods
if (isAdminWithWriteAccess(user)) {
  performAdminOperation(user);
}
```

## AI Agent Action Steps

1. **IDENTIFY** the long method in the error message
2. **READ** the method to understand its logical sections
3. **EXTRACT** logical units into separate methods with descriptive names
4. **REPLACE** inline code with method calls
5. **VERIFY** each extracted method is <70 lines
6. **TEST** that functionality remains unchanged

## Examples of "Logical Units" to Extract
- Validation logic -> `validateX()`
- Data transformation -> `transformXToY()`
- API calls -> `fetchXFromApi()`
- Object creation -> `createX()`
- Loop bodies -> `processItem()`
- Error handling -> `handleXError()`

Remember: Methods should read like a table of contents. Each line should be a "chapter title" (method call) that describes what happens, not how it happens.
