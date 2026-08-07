# BUG: `no-destructure` has no `allowedPaths`, so a React/React Native tree cannot be adopted at all

**Package:** `@webpieces/code-rules` (schema in `@webpieces/rules-config`)
**Version seen:** `0.4.449` (present since the rule was introduced)
**Severity:** Medium-High — not a wrong result, a **missing escape hatch**. `no-destructure` is the
only rule of its family with *neither* a per-path exemption *nor* a working inline disable when
`disableAllowed: false`. The result is binary: a repo that adopts React or React Native must either
weaken the rule **workspace-wide** or write React without `useState`. There is no third option, and
the two sibling rules that hit React code the same way (`no-function-outside-class`,
`inject-annotation-not-needed-for-concrete-class`) both already have the exemption.

**Source:**
- `packages/tooling/rules-config/src/rule-configs.ts:194` (`NoDestructureConfig`)
- `packages/tooling/code-rules/src/validate-no-destructure.ts`

## The bug

`NoDestructureConfig` exposes `mode`, `allowTopLevel` and `disableAllowed`, and nothing else:

```ts
export class NoDestructureConfig extends BaseRuleConfig {          // rule-configs.ts:194
    declare mode?: ModifiedCodeMode;
    allowTopLevel?: boolean;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<NoDestructureConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        allowTopLevel: FieldDef.optional('boolean'),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}
```

Compare the sibling immediately relevant to the same code — `NoFunctionOutsideClassConfig`
(`rule-configs.ts:306`), whose own doc comment describes precisely this use case:

```ts
// `allowedPaths` exempts whole file trees that legitimately live outside the class-per-behavior
// model (e.g. React component/hook files, framework glue), matched with the shared
// glob/prefix/segment semantics of `isPathExcluded`.
export class NoFunctionOutsideClassConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    disableAllowed?: boolean;
    allowedPaths?: string[];        // <-- no-destructure has no equivalent
```

`validate-no-destructure.ts` correspondingly never imports `isPathExcluded` — the import at line 46
is the only one in the family that omits it:

```ts
// validate-no-destructure.ts:46 — no isPathExcluded
import { hasDisable, RULE_NAMES, NoDestructureConfig, ModifiedCodeMode, detectBase, getChangedFiles, getFileDiff, getChangedLineNumbers } from '@webpieces/rules-config';

// validate-no-function-outside-class.ts:37 — has it
import { hasDisable, RULE_NAMES, NoFunctionOutsideClassConfig, ModifiedCodeMode, detectBase, getChangedFiles, getFileDiff, getChangedLineNumbers, isPathExcluded } from '@webpieces/rules-config';
```

### Why the inline escape does not cover it

`disableAllowed: false` is not merely "the comment is ignored" — the validator explicitly *converts*
a disabled violation back into a reported one (`recordViolation`, line 221):

```ts
if (!disableAllowed && disabled) {
    // When disableAllowed is false, ignore disable comments — still a violation
    violations.push({ line, column, context, hasDisableComment: false });
}
```

That is correct and deliberate. But it means a repo that has chosen `disableAllowed: false` — the
strict posture the rule is *for* — has **no** remaining way to exempt a directory. `allowTopLevel`
does not help: React's destructuring is inside component functions, not at module scope.

## Measurement

Consuming repo: **`/Users/deanhiller/workspace/acme-edu/consumer-repo3`** (an AI can read it directly).
Config as shipped today:

```json
"no-destructure": {
  "mode": "NEW_AND_MODIFIED_CODE",
  "disableAllowed": false,
  "ignoreModifiedUntilEpoch": 1784443590
}
```

That epoch is **2026-07-19**, so as of 2026-07-27 the rule is live and strict. The repo is adding an
Expo / React Native app under `mobile/lang-android/`. Minimal, unavoidable RN idiom and its status:

| Construct | Where it comes from | Exemptable today? |
|---|---|---|
| `const [rate, setRate] = useState(1.0)` | every React hook | ❌ no |
| `function Transport({ onPlay }: Props)` | every component's props | ❌ no |
| `const { width } = useWindowDimensions()` | RN core hooks | ❌ no |

`allowTopLevel: true` (the default) does not apply to any of them — all three sit inside a function
body or a parameter list.

The three options a consumer actually has, none of which is the one wanted:

| Option | Effect |
|---|---|
| `mode: "OFF"` | disables the rule for **every** project in the workspace |
| bump `ignoreModifiedUntilEpoch` | re-opens the grace window **workspace-wide**, silently |
| write RN without destructuring | `const s = useState(1.0); const rate = s[0]; const setRate = s[1];` in every component |

Contrast with the sibling rule in the *same* config file, which was exempted for the same directory
in one line and works:

```json
"no-function-outside-class": {
  "mode": "NEW_AND_MODIFIED_CODE",
  "disableAllowed": true,
  "allowedPaths": ["mobile/**"]     // <-- accepted; the equivalent on no-destructure is rejected
}
```

## Why this matters beyond one repo

The rule's rationale is a DI/class-per-behavior argument that is specific to the server and Angular
code webpieces governs. A React Native tree is **outside that model by construction** — the same
reason `no-function-outside-class` grew `allowedPaths` and named React in its own comment while
doing so. `no-destructure` simply never got the matching treatment, so the first repo to bring in
React/RN discovers that one rule of the set has a policy hole and the only lever is global.

The failure is also non-obvious in the worst way: `allowedPaths` on the sibling rule is *accepted*,
so the natural assumption is that the knob is uniform across the family. A consumer adds the same
key to `no-destructure` and it is rejected by the schema validator — after the RN code is already
written.

## Suggested fix

Mirror `no-function-outside-class` exactly; the two validators are structurally parallel, so this is
mechanical.

**1. `rule-configs.ts:194`** — add the field and schema entry:

```ts
export class NoDestructureConfig extends BaseRuleConfig {
    declare mode?: ModifiedCodeMode;
    allowTopLevel?: boolean;
    disableAllowed?: boolean;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<NoDestructureConfig> = {
        mode: new FieldDef('string', MODIFIED_CODE_MODES),
        allowTopLevel: FieldDef.optional('boolean'),
        disableAllowed: FieldDef.optional('boolean'),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}
```

**2. `validate-no-destructure.ts`** — import `isPathExcluded` (line 46) and guard at the single
choke point, `findDestructuringInFile` (line 151), which both traversal paths already funnel through:

```ts
function findDestructuringInFile(filePath: string, workspaceRoot: string, disableAllowed: boolean, allowedPaths: string[]): DestructureInfo[] {
    if (isPathExcluded(filePath, allowedPaths)) return [];      // <-- mirrors line 183 of the sibling
    const fullPath = path.join(workspaceRoot, filePath);
    if (!fs.existsSync(fullPath)) return [];
    ...
```

Thread `allowedPaths` through the two callers — `findViolationsForModifiedCode` (line 261) and
`findViolationsForModifiedFiles` (line 298) — and read it alongside `disableAllowed` (line 383):

```ts
const disableAllowed = options.disableAllowed ?? true;
const allowedPaths = options.allowedPaths ?? [];
```

**3. `reportViolations` (line 349)** — the `disableAllowed: false` branch currently dead-ends:

```ts
} else {
    console.error('   Escape hatch: DISABLED (disableAllowed: false)');
    console.error('   Disable comments are ignored. Fix the destructuring directly.');
}
```

Add the whole-tree line the sibling prints at its line 231, so the remaining option is discoverable
from the failure itself rather than from the source:

```
   Whole-tree exemption (e.g. React): add a glob to no-destructure.allowedPaths in webpieces.config.json
```

## Notes for whoever fixes it

- Put the guard in `findDestructuringInFile`, **not** in the two `findViolationsFor*` functions —
  the sibling does exactly this, and it keeps the exemption in one place for both `mode` branches.
- `isPathExcluded` takes the **repo-relative** path, which is what `getChangedFiles` already yields.
  Do not `path.join(workspaceRoot, ...)` before the check — the sibling guards before its own join
  (line 183 precedes line 184), and matching absolute paths against `mobile/**` would silently never
  fire. That exact class of mistake is what
  [`bug-no-file-import-cycles-excludepackages-absolute-regex-never-matches`](./bug-no-file-import-cycles-excludepackages-absolute-regex-never-matches.md)
  documents in a neighbouring rule.
- Worth auditing the rest of the family in the same pass: `catch-error-pattern`,
  `no-unmanaged-exceptions`, `require-return-type` and `no-inline-type-literals` also lack
  `allowedPaths`. The first two have `disableAllowed: true` in practice so they have *an* escape;
  `require-return-type` and `no-inline-type-literals` are configured `disableAllowed: false` in
  monorepo3 and would hit the same wall for a foreign tree.
- Regression test: a file under an `allowedPaths` glob containing `const [a, b] = useState(0)` and a
  destructured parameter must report **zero** violations with `disableAllowed: false` — the strict
  posture is the one where the hole exists, so testing with `disableAllowed: true` would pass even
  with the bug.
- Consider whether `allowedPaths` belongs in `BASE_RULE_SCHEMA` outright rather than being opted
  into per rule. Four rules declare it identically today; making it universal would remove this
  whole category of "which rules happen to support the knob" surprise. That is a larger call than
  this bug, but this is the second time the inconsistency has cost a consumer real work.
