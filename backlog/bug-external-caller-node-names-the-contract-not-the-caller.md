# BUG: the `(external caller)` node names the CONTRACT, not the caller (0.4.523)

**Package:** `@webpieces/nx-webpieces-rules`
**Version seen:** `0.4.523`
**Severity:** Medium — the one box on the diagram whose entire job is to say *who is calling us from
outside* is the one box that cannot say it. It restates the callee's own contract name instead.

## Symptom

A contract method declared `external` draws a dashed inbound box. For a WhatsApp webhook served by
`ai-chat` and posted to by **Twilio**, the graph renders:

```
┌───────────────────────┐
│      WhatsAppApi      │      <- our own contract name
│   (external caller)   │
└───────────┬───────────┘
            │ WhatsAppApi.inbound
            ▼
        ai-chat
```

The box is labelled `WhatsAppApi` — which is the name of the API *`ai-chat` implements*. The reader
already knows that; it is printed on the `ai-chat` node directly below. The single fact the box
exists to convey — that **Twilio** is the caller — appears nowhere in the diagram.

Worse, two different vendors posting to two different `external` methods of the same contract
collapse into one box, because the node id is derived from the api name alone:

```ts
const id = `inbound__${dotId(trigger.api)}`;
```

## Root cause

`packages/tooling/nx-webpieces-rules/src/lib/runtime-visualizer.ts:245-249`:

```ts
const id = `inbound__${dotId(trigger.api)}`;
dot +=
    `  "${id}" [shape=box, style="dashed,filled", fillcolor="${EXTERNAL_FILL}", ` +
    `color="${EXTERNAL_BORDER}", label="${dotValue(trigger.api)}\\n(external caller)"];\n` +
    `  "${id}" -> "${service}" [label="${label}", style=dashed, color="${EXTERNAL_BORDER}"];\n`;
```

`trigger.api` is used for both the node identity and the label. This is not a rendering oversight —
the model has nothing better to offer. `RuntimeTrigger` in `runtime-graph-model.ts:108-118` is:

```ts
kind: 'cron' | 'external';
api: string;
method: string;
service: string;
queueName?: string;      // cron only
```

There is **no field for the caller**, and `buildTriggers()` has nothing to populate one from. The
`external` method kind records *that* the call comes from outside, never *what* is outside.

Note the asymmetry: the sibling `cron` trigger renders a self-explanatory `⏰ cron` node, because
"a scheduler" is the complete truth for that case. For an inbound vendor call it is not — the
identity of the vendor is the whole point.

## Suggested fix

Give the `external` method kind an optional caller, mirroring how `@externalSystem <kind> [label]`
already lets a vendor seam name itself (`external-systems.ts`). Same JSDoc-tag mechanism, opposite
direction — outbound is already solved, inbound is not:

```ts
/**
 * Inbound WhatsApp webhook.
 * @externalCaller saas twilio
 */
abstract inbound(req: InboundReq): Promise<void>;
```

carried through as:

```ts
export interface RuntimeTrigger {
    kind: 'cron' | 'external';
    api: string;
    method: string;
    service: string;
    queueName?: string;
    /** Declared caller for `external`: who outside the repo posts to this method. */
    caller?: { kind: ExternalSystemKind; label: string };
}
```

Then in the visualizer:

- **Identity from the caller when declared** — `inbound__${dotId(caller.label)}` — so two vendors
  hitting the same contract are two boxes, and one vendor hitting three methods converges on one
  box with three arrows (exactly the convergence rule `external-systems.ts` already implements for
  outbound systems).
- **Label from the caller** — `twilio\n(external caller)`, with the contract/method already carried
  on the edge label, where it belongs.
- **Fall back to today's behaviour when undeclared**, so nothing breaks. Ideally shade the
  undeclared case differently, or label it `unknown caller → WhatsAppApi.inbound`, so "we never said
  who this is" is visually distinct from "Twilio".

Reusing `ExternalSystemKind` means an inbound `saas twilio` and an outbound `saas twilio` can be
recognised as the same vendor, which is a strictly better diagram than two unrelated boxes.

### Files

- `packages/tooling/nx-webpieces-rules/src/lib/runtime-visualizer.ts:245-249` — node id and label, both from `trigger.api`
- `packages/tooling/nx-webpieces-rules/src/lib/runtime-graph-model.ts:108-118` — `RuntimeTrigger`, no caller field
- `packages/tooling/nx-webpieces-rules/src/lib/runtime-graph.ts` — `buildTriggers()`, which would carry it through
- `packages/tooling/nx-webpieces-rules/src/lib/api-usage/external-systems.ts` — the outbound equivalent to mirror (declaration sites, kinds, identity convergence)

## Acceptance check

1. A contract declaring an inbound caller renders a box labelled with the CALLER (`twilio`), not the
   contract.
2. Two distinct callers into the same contract render as two distinct boxes.
3. One caller into several `external` methods converges on ONE box with several arrows.
4. An undeclared caller still renders, and is visually distinguishable from a declared one.
5. The contract and method remain visible on the edge label.
