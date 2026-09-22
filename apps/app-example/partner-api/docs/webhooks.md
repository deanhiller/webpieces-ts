# Receiving webhooks

You host the endpoint. We `POST` a JSON body to whatever url you register, so the reference pages for
these events list a payload and no url — the url is yours, and a sample of ours would be a sample of
an address that does not exist.

1. Register an https url that answers quickly.
2. Return any `2xx` to acknowledge. The body is ignored.
3. Do the work afterwards, not before the acknowledgement.

## Deliveries are at-least-once

The same event may arrive twice, and two events may arrive out of order. Treat `state` as the state
at `at`, and ignore an event older than one you have already applied. An endpoint that assumes
exactly-once delivery is an endpoint that will double-count a cancellation on the day we retry.
