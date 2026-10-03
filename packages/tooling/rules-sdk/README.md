# rules-sdk

Pure, versioned schema and owner/contributor value contracts. This package has no filesystem, Git,
Nx, DI, concrete rule, or execution-engine imports. API versions describe contracts and do not change
with every npm release.

A pack exports `rulePackManifest` from its `./rule-pack` package export. Each owned rule supplies a
schema, schema API version, explicit optional tuning, a complete reviewed seed, and config section.
Manifest API 2 also requires migration and safeguard catalogs; API 1 is rejected. Contributions name the canonical owner and their execution kind.
The configuration loader rejects conflicting ownership and duplicate implementations of the same
rule/execution kind. Different execution kinds may implement the same owned policy.

`FieldDef`, `SchemaShape`, `BaseRuleConfig`, and `BASE_RULE_SCHEMA` live here. Import them directly
from `@webpieces/rules-sdk`. Configuration values remain explicit: required fields have no fallback,
including required mode and universal escape-hatch fields. Concrete mode enums belong to their owners.

Shared `FILE_LIMIT_MODES`, `MODIFIED_CODE_MODES`, and `ON_OFF_MODES` scope vocabulary is exported with its union types. These are supported values; they do not choose a rule mode or supply configuration defaults.

A recommended seed is written into a client config for review; it never answers omitted required settings
at load time. Empty optional tuning must be stated as `{}`. Required fields and `mode` cannot appear in
optional tuning. Fixed safeguard IDs are reserved outside configurable rules; experimental safeguards
retain their separate machine-local opt-in and cannot be configured as ordinary rules.
