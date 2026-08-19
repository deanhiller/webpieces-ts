# BUG: `graph-visualizer` and `runtime-visualizer` still emit inline `style=` into committed HTML — the same trap `design-visualizer` was just fixed for

**Package:** `@webpieces/nx-webpieces-rules`
**Severity:** Medium — latent. It does not fail today; it fails the first time one of those artifacts
is regenerated inside a PR, and the failure will look exactly as unfixable as ONE-2632 did.

## The shape

`design-visualizer.ts` emitted its legend swatches as inline `style=` attributes. `no-custom-css`
bans inline `style=` on every `.html` it scans, so a repo that COMMITTED `design.html` made adding a
project an automatic CI failure — and the consuming repo's response was to gitignore its own
artifact rather than fix the generator. That is now fixed: the swatches are classes in the page's
`<style>` block, and `di-dot.spec.ts` pins the whole generated page against the rule's own regex.

**The fix covered one emitter, not the family.** Its siblings still do the old thing:

- `packages/tooling/nx-webpieces-rules/src/lib/graph-visualizer.ts` — lines 538, 542, 546, 550, 554
  emit `<span class="legend-box" style="background: #…">` into `architecture/dependencies.html`,
  which holds **14** inline `style=` attributes today and IS tracked in this repo.
- `packages/tooling/nx-webpieces-rules/src/lib/runtime-visualizer.ts` — same shape.

## Why it is quiet right now

`no-custom-css` runs in `NEW_AND_MODIFIED_FILES` / `NEW_AND_MODIFIED_CODE` mode: it only looks at
files the diff touched. `architecture/dependencies.html` is regenerated rarely, so it is usually not
in the changed set and the 14 hits are never evaluated. The first PR that regenerates it puts all 14
in scope at once.

There is no `allowGlobs` entry covering it, so nothing is suppressing this — it simply has not been
looked at yet.

## Fix

Same treatment `design-visualizer.ts` just received, and it is mechanical:

1. Move each swatch colour into a named class in the page's existing `<style>` block
   (`.legend-box.<kind> { background: #…; }`).
2. Replace the inline attribute with the class in the markup.
3. Add the same regression test — copy the `RE_INLINE_STYLE` guard from
   `di-dot.spec.ts`'s `generateDesignHTML emits no inline style= attribute` block and assert the
   generated page has zero flagged lines.
4. Regenerate the tracked artifacts so the committed HTML matches the new emitter.

## Worth doing at the same time

`RE_INLINE_STYLE` now has **two** hand-copies: the real one at
`code-rules/src/validate-no-custom-css.ts:48` (a private, non-exported const) and the copy in
`nx-webpieces-rules/src/lib/__tests__/di-dot.spec.ts`. Fixing the two emitters above would make it
three. Exporting it from `@webpieces/code-rules` means adding public API to a published package,
which is why the test copies it instead — but at three copies that trade flips. Decide it once,
here, rather than per-test.

**Do not "fix" this by adding an `allowGlobs` entry for `architecture/dependencies.html`.** That is
the shortcut ONE-2632 had to be talked out of: the exclusion is permanent, the CSS returns verbatim
on every regeneration, and it hides the defect instead of removing it.

## Found by

The `backwards-compat-reviewer` and `error-output-reviewer` gate run on branch
`dean/design-html-no-inline-style` — both returned yellow with this as a completeness note, i.e. the
diff is correct but does not finish the family. Deliberately kept out of that PR: it is a different
artifact with its own regeneration story, and folding it in would have doubled a finished diff.
