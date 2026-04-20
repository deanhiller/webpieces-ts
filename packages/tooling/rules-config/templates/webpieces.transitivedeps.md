# AI Agent Instructions: Redundant Transitive Dependency Violation

**READ THIS FILE FIRST before making any changes!**

## Why This Rule Exists

This rule keeps the architecture dependency graph **CLEAN and SIMPLE**.

When you run `npx nx run architecture:visualize`, it generates a visual diagram of all
package dependencies. Without this rule, you end up with a tangled mess of 100+ lines
where everything depends on everything - making it impossible to understand.

**Clean graphs = easier understanding for humans AND AI agents.**

## Understanding the Error

You have a **redundant transitive dependency**. This means:

1. Project A directly depends on Project C
2. BUT Project A also depends on Project B
3. AND Project B already brings in Project C (transitively)

Therefore, Project A's direct dependency on C is **redundant** - it's already available
through B. This extra line clutters the dependency graph.

**Example:**
```
http-server depends on: [http-routing, http-filters, core-util]
                                         ^^^^^^^^^    ^^^^^^^^
                                         REDUNDANT!   REDUNDANT!

Why? Because http-routing already brings in:
  - http-filters (direct)
  - core-util (via http-api)
```

## How to Fix

### Step 1: Identify the Redundant Dependency

Look at the error message. It tells you:
- Which project has the problem
- Which dependency is redundant
- Which other dependency already brings it in

### Step 2: Remove from project.json

Remove the redundant dependency from `build.dependsOn`:

```json
{
  "targets": {
    "build": {
      "dependsOn": [
        "^build",
        "http-routing:build"
        // REMOVE: "http-filters:build"  <-- redundant, http-routing brings it in
        // REMOVE: "core-util:build"     <-- redundant, http-routing brings it in
      ]
    }
  }
}
```

### Step 3: Remove from package.json

Remove the redundant dependency from `dependencies`:

```json
{
  "dependencies": {
    "@webpieces/http-routing": "*"
    // REMOVE: "@webpieces/http-filters": "*"  <-- redundant
    // REMOVE: "@webpieces/core-util": "*"     <-- redundant
  }
}
```

### Step 4: Regenerate Architecture

```bash
npx nx run architecture:generate
```

### Step 5: Verify

```bash
npm run build-all
```

## Important Notes

- You DON'T lose access to the transitive dependency - it's still available through the parent
- This is about keeping the DECLARED dependencies minimal and clean
- The actual runtime/compile behavior is unchanged
- TypeScript will still find the types through the transitive path

## Remember

- Fewer lines in the graph = easier to understand
- Only declare what you DIRECTLY need that isn't already transitively available
- When in doubt, check with `npx nx run architecture:visualize`
