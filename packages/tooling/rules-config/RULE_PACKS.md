# Declared rule packs

The compatibility stage adds an independent public registry while the existing engines and root
configuration keep their current behavior. Central schemas and executable binding tables remain
compatibility witnesses until the owner migration stage. Current inventory is 50 configured policies:
28 code-owned, 3 source-hook-owned, 3 workflow-owned, and 16 Nx-owned. ESLint additionally owns its
4 lint-only policies and contributes lint implementations to 4 code-owned policies.

A client discovers packages using explicit declarations and the same module-resolution boundary as
built-in packs:

```ts
import { RulePackDeclaration } from '@webpieces/rules-sdk';
import { NodeRulePackModuleLoader, RulePackDiscovery } from '@webpieces/rules-config';

const registry = new RulePackDiscovery(new NodeRulePackModuleLoader(process.cwd())).discover([
    new RulePackDeclaration('@webpieces/code-rules/rule-pack'),
    new RulePackDeclaration('@webpieces/ai-hook-rules/rule-pack'),
    new RulePackDeclaration('@webpieces/agent-workflow-rules/rule-pack'),
    new RulePackDeclaration('@webpieces/nx-webpieces-rules/rule-pack'),
    new RulePackDeclaration('@webpieces/eslint-rules/rule-pack'),
    new RulePackDeclaration('./client-policy.cjs'),
]);
```

The loader resolves from the client's package.json, with no static imports of execution packages and
no hard-coded package discovery list. A client module exports `rulePackManifest` with the SDK's
versioned data shape. Plain compiled JavaScript manifests work too; validation does not depend on
`instanceof` matching a particular installed SDK copy.

`ownerOf`, `schemaFor`, and `validateRuleConfig` use the owner's metadata. The registry requires one
owner for each declared rule, a declared matching owner for every contribution, compatible APIs, and
one contribution per execution kind. Required fields, unknown keys, enum values, array members,
nonempty arrays, and nested object schemas are validated without inventing defaults.

Shared scratch fixtures now come from `@webpieces/tooling-testkit` through devDependencies. They
are deliberately excluded from the production umbrella's dependency inventory using the explicit
`webpieces.developmentOnly` package marker, and remain independently publishable for test consumers.
