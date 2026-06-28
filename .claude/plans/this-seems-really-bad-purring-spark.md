# Plan: Exception Architecture Cleanup — Global Catches + N-Legs Pattern

## Context

The codebase has try/catch blocks scattered at every level instead of following the webpieces exception philosophy (see `packages/tooling/rules-config/templates/webpieces.exceptions.md`): errors bubble to ONE global handler per entry point.

There are TWO distinct tools that need exception handling:
1. **AI Hooks** — PreToolUse hook fired by Claude Code / OpenClaw at edit time
2. **Code Rules** — Build-time validator invoked by the Nx executor or `wp-ci` CLI

Each needs exactly ONE global try/catch at its entry point. ESLint rules are dying — no changes there.

The key architectural insight about **N legs**: N rules run during each tool invocation. Each leg (rule) must be independent — if Rule 3 crashes, Rules 4–N still run. But instead of silently swallowing the crash (returning `[]`, fail open), a crashed rule contributes a VISIBLE "rule crashed" violation to the output. This means AI sees ALL problems (violations AND crashes) at once rather than discovering them one at a time.

Similarly, both `ai-hook-rules` and `code-rules` collect ALL violations and show them together — AI fixes everything in one pass.

---

## Architecture: The Two Entry Points

### Entry Point 1: AI Hooks (2 adapters, same runner)

```
claude-code-hook.ts::main()          ← ONE global try/catch (fail closed: exit 2)
openclaw-plugin.ts::handler()        ← ONE global try/catch (fail closed: reject)
    │
    ├─ load-config.ts::loadConfig()  ← throws InformAiError on bad JSON
    ├─ load-rules.ts::loadCustomRules() ← throws InformAiError on load failure
    └─ runner.ts::runInternal()
           │
           ├─ Rule 1 leg → try/catch → violation OR "rule crashed: X" violation
           ├─ Rule 2 leg → try/catch → violation OR "rule crashed: X" violation
           └─ Rule N leg → try/catch → violation OR "rule crashed: X" violation
                    │
                    └─ All violations (including crash violations) → BlockedResult report
```

### Entry Point 2: Code Rules (CLI)

```
cli.ts::main()                       ← ONE global try/catch (fail closed: exit 1)
    │
    └─ validate-code.ts::runValidator()
           │
           ├─ validator leg 1 → errors[]
           ├─ validator leg 2 → errors[]
           └─ validator leg N → errors[]
                    │
                    └─ ALL errors displayed together → AI fixes in one pass
```

---

## `InformAiError` — Where It Lives

`InformAiError` is an `Error` subclass signaling "this message is safe and meaningful to show AI". It must live in `@webpieces/rules-config` (the common dependency) so both `ai-hook-rules` and `code-rules` can use it. The currently-added `InformAiError` in `ai-hook-rules/src/core/types.ts` must be **moved** to `rules-config`.

**Files:**
- **CREATE** `packages/tooling/rules-config/src/inform-ai-error.ts` — the class definition
- **Export** from `packages/tooling/rules-config/src/index.ts`
- **REMOVE** `InformAiError` from `packages/tooling/ai-hook-rules/src/core/types.ts` (it was added in the previous session but is in the wrong package)
- `ai-hook-rules` and `code-rules` import `InformAiError` from `@webpieces/rules-config`

```typescript
// packages/tooling/rules-config/src/inform-ai-error.ts
export class InformAiError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InformAiError';
    }
}
```

---

## Change-by-Change Breakdown

### 1. `packages/tooling/rules-config/src/load-config.ts`

**`readRawConfig()`** — Currently: `JSON.parse` throws a raw `SyntaxError` with a cryptic message.

Change: wrap `JSON.parse` in try/catch, rethrow as `InformAiError`:
```typescript
function readRawConfig(configPath: string): RawConfigFile {
    const raw = fs.readFileSync(configPath, 'utf8');
    // webpieces-disable no-unmanaged-exceptions -- rethrow as InformAiError so global catch formats message for AI
    try {
        return JSON.parse(raw) as RawConfigFile;
    } catch (err: unknown) {
        const error = toError(err);
        throw new InformAiError(
            `webpieces.config.json has invalid JSON — fix the file, then retry.\n` +
            `Parse error: ${error.message}\n` +
            `File: ${configPath}`
        );
    }
}
```

### 2. `packages/tooling/ai-hook-rules/src/core/load-rules.ts`

Two catches in `loadCustomRules()` currently log to stderr and `continue` (silently skip). Change both to **throw `InformAiError`** — a broken custom rules directory should block the hook and tell AI to fix it:

- readdirSync catch → `throw new InformAiError("Cannot read custom rules directory '${absDir}': ${error.message}")`
- require() catch → `throw new InformAiError("Cannot load custom rule '${full}': ${error.message}")`

### 3. `packages/tooling/ai-hook-rules/src/core/runner.ts`

**3a — Remove the two redundant outer catches:**

`run()` currently wraps `runInternal()` in a try/catch that returns `BlockedResult`. This is redundant — the adapter's global catch handles this. Remove the wrapper entirely:
```typescript
export function run(...): BlockedResult | null {
    return runInternal(...);  // no try/catch — let adapter's global catch handle it
}
export function runBash(...): BlockedResult | null {
    return runBashInternal(...);
}
```

**3b — Change `safeCheck*` to fail VISIBLE, not SILENT:**

The three `safeCheckBash/Edit/File` functions currently return `[]` on crash (fail open, silent). Change to return a crash violation that appears in the AI report — the "N legs" pattern:

```typescript
function runRuleCheck(rule: Rule, ctx: EditContext | FileContext | BashContext): readonly Violation[] {
    // webpieces-disable no-unmanaged-exceptions -- per-rule catch: each leg independent, crash → visible violation not silence
    try {
        return (rule as EditRule | FileRule | BashRule).check(ctx as never);
    } catch (err: unknown) {
        const error = toError(err);
        // Return a visible error violation rather than [] so AI sees the crash
        return [new Violation(0, '', `Rule '${rule.name}' crashed: ${error.message}`)];
    }
}
```

Replace the three separate `safeCheck*` functions with this one, and update `runBashRules`, `runEditRules`, `runFileRules` to call `runRuleCheck(...)`.

**Remove unused imports** (`toError` is no longer needed in runner.ts since the outer catches are gone; it IS used in the new `runRuleCheck` helper so keep it there).

### 4. `packages/tooling/ai-hook-rules/src/adapters/claude-code-hook.ts`

**4a — `safeParse()`:** Currently returns `null` on JSON parse failure (fail open). Change:
- Keep the `if (!raw || raw.trim() === '') return null;` check (empty stdin = non-file tool, allow)
- Remove try/catch, throw `InformAiError("Malformed hook input from Claude Code stdin: ${error.message}")` on parse failure

```typescript
function safeParse(raw: string): ClaudeCodePayload | null {
    if (!raw || raw.trim() === '') return null;
    // webpieces-disable no-unmanaged-exceptions -- rethrow as InformAiError so global catch messages AI
    try {
        return JSON.parse(raw) as ClaudeCodePayload;
    } catch (err: unknown) {
        const error = toError(err);
        throw new InformAiError(`Malformed hook input from Claude Code stdin: ${error.message}`);
    }
}
```

**4b — `main()` global catch:** Change from fail open (exit 0) to fail closed (exit 2). Distinguish `InformAiError` (expected, show message to AI) from unexpected crashes:

```typescript
} catch (err: unknown) {
    const error = toError(err);
    if (err instanceof InformAiError) {
        process.stderr.write(error.message + '\n');
    } else {
        process.stderr.write(`[ai-hooks] hook crashed unexpectedly — failing closed: ${error.message}\n`);
    }
    process.exit(2);
}
```

### 5. `packages/tooling/ai-hook-rules/src/adapters/openclaw-plugin.ts`

**`handler()` global catch:** Currently returns `undefined` on crash (fail open). Change to return a rejected result (fail closed):

```typescript
} catch (err: unknown) {
    const error = toError(err);
    const msg = err instanceof InformAiError
        ? error.message
        : `[ai-hooks] openclaw adapter crashed — failing closed: ${error.message}`;
    return new OpenclawHandlerResult('rejected', msg);
}
```

Also fix the `wsRoot` not-found case at line 79: currently returns `undefined` (fail open). Should return `BlockedResult` with "webpieces.config.json not found" message. Actually the runner already handles this — when `wsRoot` is null the runner can't be called, but looking at the current code it returns `undefined` which means "approve". Change to reject with the same message as runner would give.

### 6. `packages/tooling/code-rules/src/cli.ts`

Add ONE global try/catch around `main()` body:

```typescript
async function main(): Promise<void> {
    // webpieces-disable no-unmanaged-exceptions -- global entry point for code-rules CLI
    try {
        const workspaceRoot = process.cwd();
        const shared = loadConfig(workspaceRoot);
        if (!shared.configPath) {
            console.error('webpieces.config.json not found — run wp-setup-ai-hooks to initialize.');
            process.exit(1);
        }
        const options = toValidateCodeOptions(shared);
        const result = await runValidateCode(options, workspaceRoot);
        process.exit(result.success ? 0 : 1);
    } catch (err: unknown) {
        const error = toError(err);
        if (err instanceof InformAiError) {
            console.error(error.message);
        } else {
            console.error(`[code-rules] unexpected error: ${error.message}`);
        }
        process.exit(1);
    }
}
```

---

## Try/Catch Blocks to KEEP (Justified)

| File | Location | Reason to Keep |
|------|----------|----------------|
| `rejection-log.ts` (×4) | Log rotation, rmSync, readdirSync, main log write | Fire-and-forget logging must never crash the hook. Silently swallowing is CORRECT here. |
| `build-context.ts::readCurrentFileLines()` | fs.readFileSync current file | File not existing is EXPECTED for new Write targets. Fallback to 0 lines is correct. |
| `to-error.ts` | JSON.stringify fallback | Prevents infinite recursion if stringify itself throws. Pure utility. |

---

## Try/Catch Blocks in `code-rules/src/validate-*.ts` — Defer

There are ~15 try/catches in validate-*.ts files wrapping git, TypeScript compiler, and file I/O. These are boundary operations but many silently return `[]`. The right fix is to rethrow as `InformAiError` so they contribute to the "all errors at once" output. **This is a follow-on PR** — too many files to change atomically with the above. Note in the PR that these are tracked.

The one exception: `wp-ci.ts::isPluginRegistered()` catches nx.json parse failure and returns `false`. Change this to throw `InformAiError("nx.json has invalid JSON: ...")` so the global catch handles it.

Similarly `resolve-mode.ts::getCurrentBranch()` catches git failure and returns `''` — change to throw `InformAiError("Failed to determine current git branch: ...")`.

---

## Files Changed

| File | Change |
|------|--------|
| `packages/tooling/rules-config/src/inform-ai-error.ts` | CREATE — `InformAiError` class |
| `packages/tooling/rules-config/src/index.ts` | Export `InformAiError` |
| `packages/tooling/rules-config/src/load-config.ts` | `readRawConfig` wraps JSON.parse → throws `InformAiError` |
| `packages/tooling/ai-hook-rules/src/core/types.ts` | REMOVE `InformAiError` (moved to rules-config) |
| `packages/tooling/ai-hook-rules/src/core/load-rules.ts` | Both catches → throw `InformAiError` |
| `packages/tooling/ai-hook-rules/src/core/runner.ts` | Remove outer catches from `run()`/`runBash()`; replace `safeCheck*` with `runRuleCheck` that returns crash violation |
| `packages/tooling/ai-hook-rules/src/adapters/claude-code-hook.ts` | `safeParse` → rethrow as `InformAiError`; `main()` catch → fail closed exit 2 |
| `packages/tooling/ai-hook-rules/src/adapters/openclaw-plugin.ts` | `handler()` catch → fail closed (reject, not undefined) |
| `packages/tooling/code-rules/src/cli.ts` | Add ONE global try/catch |
| `packages/tooling/code-rules/src/wp-ci.ts` | `isPluginRegistered` JSON catch → `InformAiError` |
| `packages/tooling/code-rules/src/resolve-mode.ts` | `getCurrentBranch` catch → `InformAiError` |

---

## Verification

1. `pnpm run build-all` passes (no type errors, ESLint clean)
2. Run existing tests: `pnpm nx test ai-hook-rules` — all pass
3. Temporarily inject invalid JSON into `webpieces.config.json` → hook fires → AI sees "invalid JSON" message (not a silent allow)
4. Temporarily remove `webpieces.config.json` → hook fires → AI sees "not found, run wp-setup-ai-hooks"
5. Write a custom rule that throws → hook fires → AI sees "Rule X crashed: <message>" alongside any other violations
6. Verify `claude-code-hook.ts` exits 2 (not 0) on any error — check with `echo 'invalid' | node ./dist/src/adapters/claude-code-hook.js; echo $?`
