# Authentication

Two headers, together, on every call:

- `x-api-key` — your partner key.
- `x-organization-id` — the organization the key is acting for.

Neither alone is sufficient. That is not a convention this page is asserting: the contract declares
both credentials in ONE security requirement, so the published document says *and*, and a document
saying *or* would be a document nothing in the server agrees with.

## Rotating a key

Ask for a second key before you retire the first. Both are accepted while the old one is live, so a
rotation is a deploy rather than an outage.

> A key that has been in a support ticket, a screenshot or a log line is a key to rotate. We cannot
> tell from our side that it leaked.
