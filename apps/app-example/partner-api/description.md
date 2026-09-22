# Orders API

This is the example contract that ships with webpieces. It exists so `wp-openapi` has something real
to read: every feature of the generator — derived api-key security, a hidden endpoint, an outbound
webhook, a document-wide error contract and a folded response-header constant — is demonstrated by a
contract somebody could plausibly have written, not by a fixture.

Authenticate every call with both the `x-api-key` header and the `x-organization-id` header. They are
presented together; neither alone is sufficient.
