# AI Agent Instructions: File Too Long

**READ THIS FILE to fix files that are too long**

## Core Principle

With **stateless systems + dependency injection, refactor is trivial**.
Pick a method or a few and move to new class XXXXX, then inject XXXXX
into all users of those methods via the constructor.
Delete those methods from original class.

**99% of files can be less than the configured max lines of code.**

Files should contain a SINGLE COHESIVE UNIT.
- One class per file (Java convention)
- If class is too large, extract child responsibilities
- Use dependency injection to compose functionality

## Command: Reduce File Size

### Step 1: Check for Multiple Classes
If the file contains multiple classes, **SEPARATE each class into its own file**.

```typescript
// BAD: UserController.ts (multiple classes)
export class UserController { /* ... */ }
export class UserValidator { /* ... */ }
export class UserNotifier { /* ... */ }

// GOOD: Three separate files
// UserController.ts
export class UserController { /* ... */ }

// UserValidator.ts
export class UserValidator { /* ... */ }

// UserNotifier.ts
export class UserNotifier { /* ... */ }
```

### Step 2: Extract Child Responsibilities (if single class is too large)

#### Pattern: Create New Service Class with Dependency Injection

```typescript
// BAD: UserController.ts (800 lines, single class)
@provideSingleton()
@Controller()
export class UserController {
  // 200 lines: CRUD operations
  // 300 lines: validation logic
  // 200 lines: notification logic
  // 100 lines: analytics logic
}

// GOOD: Extract validation service
// 1. Create UserValidationService.ts
@provideSingleton()
export class UserValidationService {
  validateUserData(data: UserData): ValidationResult {
    // 300 lines of validation logic moved here
  }

  validateEmail(email: string): boolean { /* ... */ }
  validatePassword(password: string): boolean { /* ... */ }
}

// 2. Inject into UserController.ts
@provideSingleton()
@Controller()
export class UserController {
  constructor(
    @inject(TYPES.UserValidationService)
    private validator: UserValidationService
  ) {}

  async createUser(data: UserData): Promise<User> {
    const validation = this.validator.validateUserData(data);
    if (!validation.isValid) {
      throw new ValidationError(validation.errors);
    }
    // ... rest of logic
  }
}
```

## AI Agent Action Steps

1. **ANALYZE** the file structure:
   - Count classes (if >1, separate immediately)
   - Identify logical responsibilities within single class

2. **IDENTIFY** "child code" to extract:
   - Validation logic -> ValidationService
   - Notification logic -> NotificationService
   - Data transformation -> TransformerService
   - External API calls -> ApiService
   - Business rules -> RulesEngine

3. **CREATE** new service file(s):
   - Start with temporary name: `XXXX.ts` or `ChildService.ts`
   - Add `@provideSingleton()` decorator
   - Move child methods to new class

4. **UPDATE** dependency injection:
   - Add to `TYPES` constants (if using symbol-based DI)
   - Inject new service into original class constructor
   - Replace direct method calls with `this.serviceName.method()`

5. **RENAME** extracted file:
   - Read the extracted code to understand its purpose
   - Rename `XXXX.ts` to logical name (e.g., `UserValidationService.ts`)

6. **VERIFY** file sizes:
   - Original file should now be under the limit
   - Each extracted file should be under the limit
   - If still too large, extract more services

## Examples of Child Responsibilities to Extract

| If File Contains | Extract To | Pattern |
|-----------------|------------|---------|
| Validation logic (200+ lines) | `XValidator.ts` or `XValidationService.ts` | Singleton service |
| Notification logic (150+ lines) | `XNotifier.ts` or `XNotificationService.ts` | Singleton service |
| Data transformation (200+ lines) | `XTransformer.ts` | Singleton service |
| External API calls (200+ lines) | `XApiClient.ts` | Singleton service |
| Complex business rules (300+ lines) | `XRulesEngine.ts` | Singleton service |
| Database queries (200+ lines) | `XRepository.ts` | Singleton service |

## WebPieces Dependency Injection Pattern

```typescript
// 1. Define service with @provideSingleton
import { provideSingleton } from '@webpieces/http-routing';

@provideSingleton()
export class MyService {
  doSomething(): void { /* ... */ }
}

// 2. Inject into consumer
import { inject } from 'inversify';
import { TYPES } from './types';

@provideSingleton()
@Controller()
export class MyController {
  constructor(
    @inject(TYPES.MyService) private service: MyService
  ) {}
}
```

## Escape Hatch

If refactoring is genuinely not feasible (generated files, complex algorithms, etc.),
add a disable comment at the TOP of the file (within first 5 lines) with a DATE:

```typescript
// webpieces-disable max-lines-modified-files 2025/01/15 -- Complex generated file, refactoring would break generation
```

**IMPORTANT**: The date format is yyyy/mm/dd. The disable will EXPIRE after 1 month from this date.
After expiration, you must either fix the file or update the date to get another month.
This ensures that disable comments are reviewed periodically.

For ESLint-enforced file size limits, use:

```typescript
// eslint-disable-next-line @webpieces/max-file-lines
```

Remember: Find the "child code" and pull it down into a new class. Once moved, the code's purpose becomes clear, making it easy to rename to a logical name.
