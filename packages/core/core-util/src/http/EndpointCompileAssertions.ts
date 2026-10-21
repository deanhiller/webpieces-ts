import { NONE } from './HttpEndpointOptions';
import { CLOUDTASKS, CRON, DELETE, GET, READ, Endpoint, EXTERNAL_INBOUND, EXTERNAL_OUTBOUND, PATCH, POST, PUT, RPC, WRITE, WRITE_IDEMPOTENT } from './decorators';

Endpoint(POST, '/valid-rpc', WRITE, RPC);
Endpoint(PUT, '/valid-put', WRITE_IDEMPOTENT, RPC);
Endpoint(PATCH, '/valid-patch', WRITE, RPC);
Endpoint(DELETE, '/valid-delete', WRITE_IDEMPOTENT, RPC);
Endpoint(POST, '/valid-external', WRITE, EXTERNAL_INBOUND, { calledBy: 'twilio' });
Endpoint(GET, '/valid-outbound', READ, EXTERNAL_OUTBOUND);

// @ts-expect-error inbound external endpoints require options containing calledBy
Endpoint(POST, '/missing-external-options', WRITE, EXTERNAL_INBOUND);

// @ts-expect-error inbound external endpoint options require calledBy
Endpoint(POST, '/missing-external-caller', WRITE, EXTERNAL_INBOUND, { formPost: true });

// @ts-expect-error callerKind is a closed enum-backed union rather than free text
Endpoint(POST, '/invalid-caller-kind', WRITE, EXTERNAL_INBOUND, {
    calledBy: 'twilio',
    callerKind: 'vendor',
});

// @ts-expect-error callers must import the enum-backed operation constant
Endpoint(POST, '/raw-operation', 'write', RPC);

// @ts-expect-error callers must import the enum-backed HTTP method constant
Endpoint('POST', '/raw-method', WRITE, RPC);

// @ts-expect-error callers must import the enum-backed trigger-kind constant
Endpoint(POST, '/raw-trigger', WRITE, 'rpc');

// @ts-expect-error callers must import the enum-backed HTTP method constant, for the new verbs too
Endpoint('PUT', '/raw-put', WRITE, RPC);

// A CLOUDTASKS / CRON endpoint has no response body BY KIND, an EXTERNAL_OUTBOUND one is shaped by the
// vendor (#1348); NONE stays a declaration only where OUR server answers (RPC, EXTERNAL_INBOUND).
Endpoint(POST, '/valid-task', WRITE, CLOUDTASKS);
Endpoint(POST, '/valid-cron', WRITE, CRON, { noLogging: true });
Endpoint(POST, '/valid-rpc-void', WRITE, RPC, { responseBody: NONE });
Endpoint(DELETE, '/valid-outbound-void', WRITE_IDEMPOTENT, EXTERNAL_OUTBOUND);
Endpoint(POST, '/valid-inbound-void', WRITE, EXTERNAL_INBOUND, { calledBy: 'twilio', responseBody: NONE });

// @ts-expect-error CLOUDTASKS already implies no response body; responseBody: NONE is a second spelling
Endpoint(POST, '/redundant-task-none', WRITE, CLOUDTASKS, { responseBody: NONE });

// @ts-expect-error CRON already implies no response body; responseBody: NONE is a second spelling
Endpoint(POST, '/redundant-cron-none', WRITE, CRON, { responseBody: NONE });

// @ts-expect-error the vendor shapes an EXTERNAL_OUTBOUND response; responseBody: NONE describes OUR server
Endpoint(DELETE, '/outbound-none', WRITE_IDEMPOTENT, EXTERNAL_OUTBOUND, { responseBody: NONE });
