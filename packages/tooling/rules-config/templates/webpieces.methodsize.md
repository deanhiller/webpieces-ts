# Instructions: Method Too Long

## Requirement

**~99% of the time**, you can stay under the `limit` from nx.json
by extracting logical units into well-named methods.
Nearly all software can be written with methods under this size.
Take the extra time to refactor - it's worth it for long-term maintainability.

## The "Table of Contents" Principle

Good code reads like a book's table of contents:
- Chapter titles (method names) tell you WHAT happens
- Reading chapter titles gives you the full story
- You can dive into chapters (implementations) for details

## Why Limit Method Sizes?

Methods under reasonable limits are:
- Easy to review in a single screen
- Simple to understand without scrolling
- Quick for AI to analyze and suggest improvements
- More testable in isolation
- Self-documenting through well-named extracted methods

## Gradual Cleanup Strategy

This codebase uses a gradual cleanup approach:
- **New methods**: Must be under `limit` from nx.json
- **Modified methods**: Must be under `limit` from nx.json
- **Untouched methods**: No limit (legacy code is allowed until touched)

## How to Refactor

Instead of:
```typescript
async processOrder(order: Order): Promise<Result> {
    // 100 lines of validation, transformation, saving, notifications...
}
```

Write:
```typescript
async processOrder(order: Order): Promise<Result> {
    const validated = this.validateOrder(order);
    const transformed = this.applyBusinessRules(validated);
    const saved = await this.saveToDatabase(transformed);
    await this.notifyStakeholders(saved);
    return this.buildResult(saved);
}
```

Now the main method is a "table of contents" - each line tells part of the story!

## Patterns for Extraction

### Pattern 1: Extract Loop Bodies
```typescript
// BEFORE
for (const item of items) {
    // 20 lines of processing
}

// AFTER
for (const item of items) {
    this.processItem(item);
}
```

### Pattern 2: Extract Conditional Blocks
```typescript
// BEFORE
if (isAdmin(user)) {
    // 15 lines of admin logic
}

// AFTER
if (isAdmin(user)) {
    this.handleAdminUser(user);
}
```

### Pattern 3: Extract Data Transformations
```typescript
// BEFORE
const result = {
    // 10+ lines of object construction
};

// AFTER
const result = this.buildResultObject(data);
```

## If Refactoring Is Not Feasible

Sometimes methods genuinely need to be longer (complex algorithms, state machines, etc.).

**Escape hatch for new methods**: Add a webpieces-disable comment with justification:

```typescript
// webpieces-disable max-lines-new-methods -- Complex state machine, splitting reduces clarity
async complexStateMachine(): Promise<void> {
    // ... longer method with justification
}
```

**Escape hatch for modified methods**: Add a webpieces-disable comment with DATE and justification:

```typescript
// webpieces-disable max-lines-modified 2025/01/15 -- Complex state machine, splitting reduces clarity
async complexStateMachine(): Promise<void> {
    // ... longer method with justification
}
```

**IMPORTANT**: The date format is yyyy/mm/dd. The disable will EXPIRE after 1 month from this date.
After expiration, you must either fix the method or update the date to get another month.
This ensures that disable comments are reviewed periodically.

## AI Agent Action Steps

1. **READ** the method to understand its logical sections
2. **IDENTIFY** logical units that can be extracted
3. **EXTRACT** into well-named private methods
4. **VERIFY** the main method now reads like a table of contents
5. **IF NOT FEASIBLE**: Add webpieces-disable comment with clear justification

## Remember

- Every method you write today will be read many times tomorrow
- The best code explains itself through structure
- When in doubt, extract and name it
