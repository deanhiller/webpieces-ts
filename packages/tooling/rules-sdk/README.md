# rules-sdk

Pure, versioned schema and owner/contributor value contracts. This package has no filesystem, Git,
Nx, DI, concrete rule, or execution-engine imports. API versions describe contracts and do not change
with every npm release.

A pack exports `rulePackManifest` from its `./rule-pack` package export. Each owned rule supplies a
schema and schema API version. Contributions name the canonical owner and their execution kind.
The configuration loader rejects conflicting ownership and duplicate implementations of the same
rule/execution kind. Different execution kinds may implement the same owned policy.

`FieldDef`, `SchemaShape`, `BaseRuleConfig`, and `BASE_RULE_SCHEMA` live here. Import them directly
from `@webpieces/rules-sdk`. Configuration values remain explicit: required fields have no fallback,
including required mode and universal escape-hatch fields. Concrete mode enums belong to their owners.
