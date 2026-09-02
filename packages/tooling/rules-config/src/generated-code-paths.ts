// The machine-generated file trees that a LINE-COUNT rule must never fire on.
//
// WHY THIS IS A FLOOR AND NOT A DEFAULT VALUE
// A `graphql-codegen` client-preset output is 42,000 lines because it embeds the whole upstream
// schema — the size is a property of a schema nobody in the consuming repo owns, so "refactor it"
// is not advice, it is an impossibility. Before this existed the only escape from max-file-lines was
// `turnOffRuleUntilEpoch`, a GLOBAL off-switch that also stopped the rule on hand-written files —
// i.e. the protection was removed exactly when a real 1,500-line service class could slip in.
//
// So these globs are exempt UNCONDITIONALLY, and a rule's own `allowedPaths` ADDS to them rather
// than replacing them. A consumer who configures `allowedPaths` for one of their own trees cannot
// silently lose the generated-code exemption and re-acquire the incident.
//
// Matched with the shared `isPathExcluded` glob/prefix/segment semantics, so a bare `dist` matches a
// `dist` segment at any depth — build output, by construction not authored by anybody.
export const GENERATED_CODE_PATHS: readonly string[] = [
    '**/__generated__/**',
    '**/generated/**',
    '**/*.generated.ts',
    '**/*.generated.tsx',
    'dist',
];
