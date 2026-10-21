import { Endpoint, EXTERNAL, POST, RPC, WRITE } from './decorators';

Endpoint(POST, '/valid-rpc', WRITE, RPC);
Endpoint(POST, '/valid-external', WRITE, EXTERNAL, { calledBy: 'twilio' });

// @ts-expect-error external endpoints require options containing calledBy
Endpoint(POST, '/missing-external-options', WRITE, EXTERNAL);

// @ts-expect-error external endpoint options require calledBy
Endpoint(POST, '/missing-external-caller', WRITE, EXTERNAL, { formPost: true });

// @ts-expect-error callerKind is a closed enum-backed union rather than free text
Endpoint(POST, '/invalid-caller-kind', WRITE, EXTERNAL, {
    calledBy: 'twilio',
    callerKind: 'vendor',
});

// @ts-expect-error callers must import the enum-backed operation constant
Endpoint(POST, '/raw-operation', 'write', RPC);

// @ts-expect-error callers must import the enum-backed HTTP method constant
Endpoint('POST', '/raw-method', WRITE, RPC);

// @ts-expect-error callers must import the enum-backed trigger-kind constant
Endpoint(POST, '/raw-trigger', WRITE, 'rpc');
