# Instructions: Authoring responsibilities.md Files

Every project in the workspace MUST have a `responsibilities.md` at its project root
(next to its `project.json` / `package.json`). The architecture generator embeds each
file's first paragraph into `architecture/dependencies.json` as that project's
`shortDescription`, and records the file path as `responsibilitiesFile` so AI can read
the full detail on demand.

## Required Format

```markdown
# Responsibilities — <project-name>

One SHORT paragraph (max 300 characters) summarizing what this module does.
This paragraph is embedded verbatim into architecture/dependencies.json as
shortDescription, so keep it tight and information-dense.

## In Scope

- What kinds of code BELONG in this module
- The problems this module solves

## Out of Scope

- What does NOT belong here, and which module it belongs in instead

## Notes (optional)

Anything else future developers/AI should know: key design decisions,
invariants, gotchas.
```

Rules the generator enforces:
- The file must exist for EVERY project in the dependency graph.
- The first non-heading paragraph must be non-empty and at most 300 characters
  (newlines are collapsed to spaces before measuring).

## How This Is Used

`architecture/dependencies.json` is written for AI consumption. Each project entry has:
- `shortDescription` — the summary paragraph from this file
- `responsibilitiesFile` — path to this file (read it BEFORE adding code to the module,
  to know what belongs there and what does not)
- `designFile` — path to the generated DI design.json for the module
- `framework` — angular | react | express | all-ts (from the `framework:<x>` nx tag in
  project.json, or inferred from package.json dependencies)

## Fixing a Validation Failure

1. Create or fix the `responsibilities.md` files listed in the error output
   (a HUMAN should review the content — describe real intent, don't restate the code).
2. Re-run: `nx run architecture:generate`
3. Commit both the `responsibilities.md` files and the regenerated
   `architecture/dependencies.json`.

## Editing an Existing responsibilities.md

If you change the FIRST paragraph, the embedded `shortDescription` in
`architecture/dependencies.json` becomes stale and the build will fail until you re-run
`nx run architecture:generate` and commit the regenerated file. Detail sections below the
first paragraph can be edited freely without regenerating.
