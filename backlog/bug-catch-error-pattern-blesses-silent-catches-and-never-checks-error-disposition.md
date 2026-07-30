# BUG: `catch-error-pattern` treats a commented-out `toError` as compliant, and neither exception rule looks at what the catch does with the error — so the maximally-approved way to write a catch is to throw the error away

**Packages:** `@webpieces/eslint-rules`, `@webpieces/ai-hook-rules`
**Version seen:** `0.4.469`
**Severity:** High — the two rules that exist specifically to stop swallowed exceptions rate a
*completely silent* catch as fully conformant, and rate "render `err.message` inline and drop the
correlation id" as fully conformant. Both then hand out a one-line disable comment that makes the
advisory text vanish. A consuming repo can be 100% green on both rules and have no path from a
production 500 to its own logs.

**Source:**
- `packages/tooling/eslint-rules/src/rules/catch-error-pattern.ts:102-117` (`hasIgnoreComment`) and `:236-238` (the early return)
- `packages/tooling/ai-hook-rules/src/core/rules/catch-error-pattern.ts:19` (`TO_ERROR_PATTERN`, note the `(?:\/\/\s*)?`)
- `packages/tooling/ai-hook-rules/src/core/rules/no-unmanaged-exceptions.ts:13` (`DISABLE_PATTERN`)

## What happened

Consuming repo: **`/Users/deanhiller/workspace/ctoteachings/monorepo1`** (an AI can read it directly).

A learner on `language.ctoteachings.com/onboarding` clicked Next on the placement step and got a red
inline `Internal Server Error`. Nothing else — no correlation id, no dialog, no Sentry event. The
webpieces `actionId` (`WebpiecesCoreHeaders.ACTION_ID`, minted browser-side and ridden out on every
call of the action) exists precisely so one grep pulls the whole server-side trace of that click, and
the app has a `GlobalErrorHandler` that renders it. The user never saw it, because the code caught
the error 200ms before it would have reached that chokepoint.

Here is the code, verbatim, from
`services/angular/lang-angular/src/app/pages/onboarding/onboarding.component.ts:141-167`:

```ts
async save(): Promise<void> {
    const choice = this.choice;
    const levelId = this.levelId;
    if (!choice || levelId === null) {
        return;
    }
    this.busy = true;
    this.error = null;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- surfaced inline; the wizard stays usable
    try {
        const settings = await this.secureApi.completeOnboarding({
            learnLanguage: choice.learn.languageId,
            nativeLanguage: choice.native.code,
            levelId,
        });
        this.context.accept(settings);
        this.page = 'review';
    } catch (err: unknown) {
        // eslint-disable-next-line @webpieces/catch-error-pattern -- shown inline so the user can retry
        this.error = toError(err).message;
    } finally {
        this.busy = false;
    }
}
```

**This passes `nx lint`, `nx run <p>:ci`, and CI.** It is not even relying on the disable comments to
pass `catch-error-pattern` — the param is `err`, it is typed `unknown`, and the first statement is a
`toError(err)` call. It is *textbook compliant*. The disable comment on the catch is redundant, which
is itself the tell: the author added it because the rule message made catching feel forbidden, and
the rule then let it through anyway.

The bug it hid: an fsdb write started passing `undefined` for two optional fields, the Firestore Admin
SDK threw, webpieces returned its generic 500, and `toError(err).message` rendered the string
`Internal Server Error` in a `<p class="text-red-600">`. **100% reproducible for every user
completing onboarding**, and undiagnosable from the browser.

A sweep of that repo found 15 more sites in one app and 7 in the other with the same shape, plus four
that are *entirely* silent. All green.

## The two defects

### 1. `//const error = toError(err);` is an approved pattern

ESLint side — `catch-error-pattern.ts:102-117`:

```ts
const ignorePattern = new RegExp(
    `//\\s*const\\s+${expectedVarName}\\s*=\\s*toError\\(${actualParamName}\\)`,
);
return ignorePattern.test(catchBlockText);
```

and at `:236-238`, a hit returns early with **no report at all**. Hook side, same thing baked into
one regex — `ai-hook-rules/.../catch-error-pattern.ts:19`:

```ts
const TO_ERROR_PATTERN = /^\s*(?:\/\/\s*)?const\s+(\w+)\s*=\s*toError\(\s*(\w+)\s*\)\s*;?\s*$/;
//                                  ^^^^^^^^^^^^^  the commented-out form is first-class
```

So this is the highest-conformance catch block expressible in the system:

```ts
} catch (err: unknown) {
    //const error = toError(err);
}
```

Zero diagnostics, zero disable comments, zero reviewer signal. In monorepo1 that exact block is at
`settings.component.ts:178`, `:207`, `words.component.ts:192`, `token-store.ts:57`,
`auth-client.service.ts:57`. Deleting an error should be the loudest thing in a file; here it is the
quietest.

### 2. Neither rule inspects the disposition of the error

`no-unmanaged-exceptions` is a line regex for `\btry\s*\{` — it never sees the catch body at all.
`catch-error-pattern` validates the **shape of the first statement** and stops
(`validateToErrorCall`, `:132-181`). Neither has any concept of *rethrow* or *forward to the
chokepoint*.

Yet the message asserts the invariant explicitly:

> `try/catch is generally not allowed. Only chokepoints (filter, globalErrorHandler) may catch exceptions.`

That sentence is the thing worth enforcing, and it is the one thing nothing checks. `toError(err)` is
treated as the goal when it is only a type narrowing — `const error = toError(err); this.msg = error.message;`
satisfies every rule while destroying the trace. The rule ends up enforcing *ceremony* (param named
`err`, typed `unknown`, `toError` on line one) rather than *outcome*.

### 2a. The reason strings are self-justifying, unverified, and in this case simply false

Both disable comments above carry a `-- reason`. Read them against the code:

> `-- surfaced inline; the wizard stays usable`
> `-- shown inline so the user can retry`

**Deleting the catch entirely gives you a strictly better version of both claims.** `finally { this.busy = false }`
runs either way, so the button re-enables. The wizard component is still mounted — `GlobalErrorHandler`
opens a MatDialog *over* it, with a Close button. The user clicks Close and clicks Next again. That
is the same retry, except now the dialog also shows them the Action ID and the failure reached Sentry.

So the catch delivered **nothing** its own justification claims, and destroyed the trace to buy it.
This matters for rule design: the `-- reason` field reads like accountability and functions as
autocomplete. It is written by whoever wants the rule to stop complaining, at the moment they want it
to stop complaining, and nothing ever re-reads it — the comment is invisible in every later diff. Any
fix that keeps "write a reason inline" as the escape hatch will produce more of exactly this. The
escape has to land somewhere a second person looks, which is the argument for the central `allow`
list in (2) rather than a better-worded comment.

### 2b. The disable comment silences the advice, not the risk

Both rules ship `disableAllowed: true` by default and print the escape hatch in the hint
(`DisableEscape(...)` at `no-unmanaged-exceptions.ts:40`, `catch-error-pattern.ts:56`). An AI reading
"only chokepoints may catch" plus "here is how to disable this" reliably picks disable, writes a
plausible reason (`-- surfaced inline; the wizard stays usable` — which is even *true*, and still
wrong), and moves on. The reason string is never re-reviewed because it is not in a diff anybody
looks at twice.

Note the `disableAllowed: false` knob exists and works — **on the hook side only**
(`no-unmanaged-exceptions.ts:45-52`, `catch-error-pattern.ts:61-71`). The ESLint rules ignore
`webpieces.config.json` entirely and honor `// eslint-disable-next-line` because ESLint core
suppresses the report before the rule is consulted. So today the hook and the linter disagree about
whether a disable is allowed, and the linter — the one wired into CI — always loses.

## Suggested fix

Three pieces. (1) is a one-line behaviour change, (2) is the real fix, (3) is what gives (2) teeth.

### 1. Require an explicit annotation for the ignore form

Keep the escape, stop making it free. `//const error = toError(err);` alone should report; require it
to carry a reason, e.g. `//const error = toError(err); -- <why swallowing is correct>`, and report
`swallowNeedsReason` otherwise. One regex change in each package, plus the message. This alone turns
five silent catches in monorepo1 into five reviewed decisions.

### 2. A new rule: `errors-must-reach-chokepoint`

`catch-error-pattern` is about shape and should stay about shape. The invariant in its own message
deserves its own rule. Sketch, matching the existing rule file conventions in
`packages/tooling/eslint-rules/src/rules/`:

```ts
// packages/tooling/eslint-rules/src/rules/errors-must-reach-chokepoint.ts
import type { Rule } from 'eslint';

const DEFAULT_FORWARDS = ['handleError', 'reportError', 'captureException', 'throwError'];

/**
 * Does this catch body dispose of the error rather than eat it? True if it rethrows, or hands the
 * error to a chokepoint. Nested function bodies are NOT searched: a `throw` inside a callback
 * declared in the catch runs later, on a different stack, and does not propagate to this caller.
 */
// webpieces-disable no-any-unknown -- ESTree nodes are dynamically shaped
function disposesOfError(node: any, forwards: string[]): boolean {
    if (!node || typeof node.type !== 'string') return false;
    if (node.type === 'ThrowStatement') return true;
    if (node.type === 'CallExpression') {
        const callee = node.callee;
        const name = callee?.type === 'Identifier' ? callee.name
            : callee?.type === 'MemberExpression' && callee.property?.type === 'Identifier'
                ? callee.property.name : undefined;
        if (name && forwards.includes(name)) return true;
    }
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression'
        || node.type === 'FunctionDeclaration') return false;
    for (const key of Object.keys(node)) {
        if (key === 'parent') continue;
        const child = node[key];
        if (Array.isArray(child)) {
            if (child.some((c) => disposesOfError(c, forwards))) return true;
        } else if (child && typeof child === 'object' && disposesOfError(child, forwards)) {
            return true;
        }
    }
    return false;
}

const rule: Rule.RuleModule = {
    meta: {
        type: 'problem',
        docs: { description: 'A caught error must rethrow or reach the global error chokepoint.' },
        messages: {
            swallowed:
                'This catch neither rethrows nor forwards to a chokepoint ({{forwards}}), so the ' +
                'error never reaches the global handler and its actionId is lost. Rethrow, forward ' +
                'it, or add this file to the central `allow` list with a written reason.',
            disableNotHonored:
                'This rule cannot be disabled inline — that is the failure mode it exists to stop. ' +
                'Add the file to the central `allow` list with a reason instead.',
        },
        schema: [{
            type: 'object',
            properties: {
                allow: { type: 'array', items: { type: 'string' } },
                forwards: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
        }],
    },

    create(context: Rule.RuleContext): Rule.RuleListener {
        const opts = (context.options[0] ?? {}) as { allow?: string[]; forwards?: string[] };
        const forwards = opts.forwards ?? DEFAULT_FORWARDS;
        const file = context.filename.replace(`${context.cwd}/`, '');
        if ((opts.allow ?? []).some((entry) => file.endsWith(entry.split(' -- ')[0]!.trim()))) {
            return {};
        }

        function check(body: any, node: any): void {
            if (!disposesOfError(body, forwards)) {
                context.report({ node, messageId: 'swallowed', data: { forwards: forwards.join(', ') } });
            }
        }

        return {
            // webpieces-disable no-any-unknown -- ESLint visitor receives untyped AST nodes
            CatchClause(node: any): void { check(node.body, node); },

            // `.catch(cb)` and rxjs `catchError(cb)` are the same hazard with different syntax.
            CallExpression(node: any): void {
                const callee = node.callee;
                const name = callee?.type === 'MemberExpression' && callee.property?.type === 'Identifier'
                    ? callee.property.name
                    : callee?.type === 'Identifier' ? callee.name : undefined;
                if (name !== 'catch' && name !== 'catchError') return;
                const handler = node.arguments[0];
                if (!handler || (handler.type !== 'ArrowFunctionExpression'
                    && handler.type !== 'FunctionExpression')) return;
                check(handler.body, node);
            },
        };
    },
};

export = rule;
```

Run against the block at the top of this report it reports `swallowed`, because
`this.error = toError(err).message;` is neither a `throw` nor a forward. Deleting the try/catch —
the correct fix — makes it pass.

### 3. Make the ESLint side honor `disableAllowed: false`

Without this, (2) is one comment away from being advisory, which is exactly how we got here. ESLint
core strips a report on a line covered by `eslint-disable-next-line` before the rule sees it — but
the *directive comment itself* is on the preceding line, which is not covered. So the rule can
detect its own suppression and report where the suppression cannot reach:

```ts
// add to create() in the rule above
const source = context.sourceCode;
return {
    // ... CatchClause / CallExpression as above ...
    'Program:exit'(): void {
        for (const comment of source.getAllComments()) {
            const text = comment.value;
            if (!/eslint-disable(-next-line|-line)?\b/.test(text)) continue;
            if (!text.includes('errors-must-reach-chokepoint')) continue;
            // Reported ON the directive's own line: `-next-line` covers the line BELOW it, so this
            // report survives. That is the point — this rule is not disable-able inline.
            context.report({ node: comment as never, messageId: 'disableNotHonored' });
        }
    },
};
```

That covers `eslint-disable-next-line`, which is the form that actually appears in practice (both
comments in the repro above). A whole-file `/* eslint-disable */` block does cover its own line and
still wins — so pair this with the hook-side rule, where `disableAllowed: false` already works
correctly, and the two layers close each other's gap.

The cleaner long-term option is for `wp-upgrade-shim` to emit
`linterOptions: { noInlineConfig: true }` on a generated flat-config block scoped to the files this
rule guards — but that bans inline config for *every* rule in those files, so it is a bigger product
call than this report should make.

## Notes for whoever fixes it

- **The `allow` list must be central and in config, not per-file comments.** The whole failure mode
  is that a local comment ends the conversation. A consuming repo already demonstrates the good
  shape: `monorepo1/eslint.config.mjs:207-225` keeps a `wp-local/spec-must-use-api-client` `allow`
  array with a written justification per entry, so adding an exemption is a reviewed diff. Copy that.
- **Legitimate swallows are real and must stay cheap to declare.** The monorepo1 sweep found ~14 that
  should keep swallowing: the log shipper itself (logging its own failure recurses),
  `localStorage`/`sessionStorage` throwing by design in Safari private mode, `Intl.DisplayNames` on a
  tag the browser doesn't know, autoplay-policy rejections, and service-worker recovery paths that run
  *while already handling* an error. A rule that cannot express these will be turned off.
- **Consider a third disposition: report-without-dialog.** Several of the above want the error in
  Sentry but not in the user's face. If `forwards` includes a `reportError`-style call, the rule
  supports this already — worth saying so in the docs, because otherwise the only two options look
  like "dialog" or "silence" and people pick silence.
- **`no-unmanaged-exceptions` should probably defer.** Once (2) exists, a `try` whose catch rethrows
  or forwards is fine, and the blanket `\btry\s*\{` regex is mostly generating disable comments —
  which is what trained the bad habit. Consider making it a warn, or scoping it to code where no
  chokepoint exists.
- **Regression tests:** (a) `} catch (err: unknown) { //const error = toError(err); }` must now
  report under (1); (b) the exact `save()` body above must report `swallowed`; (c) the same body with
  `throw err;` appended must pass; (d) a file listed in `allow` must pass; (e) an
  `// eslint-disable-next-line @webpieces/errors-must-reach-chokepoint` above the catch must still
  produce a `disableNotHonored` report.
