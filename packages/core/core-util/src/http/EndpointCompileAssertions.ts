import { DELETE, GET, READ, Endpoint, EXTERNAL_INBOUND, EXTERNAL_OUTBOUND, PATCH, POST, PUT, RPC, WRITE, WRITE_IDEMPOTENT } from './decorators';

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
