# Responsibilities — webpieces-tooling

Thin installation umbrella for the complete webpieces toolchain and the single combined OpenClaw write/edit hook. Owns package materialization and composition smoke checks.

## In Scope

- Workspace dependencies that ship every tooling package and existing public bin.
- The OpenClaw adapter and metadata, composing source and workflow providers in their established order.
- Small manifest, bin, publication-order, and composition checks.

## Out of Scope

- Concrete source rules, workflow policies, hook installation, and their feature suites.
- PR workflow orchestration and Nx plugin/executor implementation.
- Shared configuration or hook-runtime contracts.
