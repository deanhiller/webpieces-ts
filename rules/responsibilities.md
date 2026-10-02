# Root rules policy

This project owns validation of the repository-level `webpieces.config.json` policy without making
that configuration a shared input of product projects.

## Responsibilities

- Validate the root rules declaration before affected CI runs.
- Define the narrowly scoped Nx inputs that can invalidate the policy check.
- Keep repository policy changes from scheduling product compilation, lint, or tests by themselves.
