import * as path from 'path';
import { createRequire } from 'module';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

/** What the fake server does with ONE createTask call. */
export enum FakeBehavior {
    /** Answer the task (named as sent, or server-assigned). */
    OK = 'ok',
    /** UNAVAILABLE (14) — what grpc-js surfaces for a connection reset. */
    RESET = 'reset',
    /** ALREADY_EXISTS (6). */
    ALREADY_EXISTS = 'already-exists',
    /** Never answer: only the client's deadline can end the call. */
    SILENT = 'silent',
}

/** One createTask the fake server received, as it arrived on the wire. */
export class ReceivedCreateTask {
    cancelled = false;

    constructor(
        /** `task.name` exactly as sent; '' or undefined when the client sent none. */
        readonly taskName: string | undefined,
        /** Milliseconds left on the gRPC deadline when the call arrived (Infinity = none sent). */
        readonly deadlineMs: number,
        /** `task.dispatchDeadline.seconds`, if the request carried one. */
        readonly dispatchDeadlineSeconds: string | undefined,
        /** `task.httpRequest.headers`. */
        readonly headers: Record<string, string>,
    ) {}
}

/* eslint-disable @typescript-eslint/no-explicit-any -- grpc-js handler payloads are untyped proto objects */
// webpieces-disable no-any-unknown -- grpc-js unary handler payloads are untyped proto-loader objects
type UnaryCall = grpc.ServerUnaryCall<any, any>;
// webpieces-disable no-any-unknown -- grpc-js unary handler payloads are untyped proto-loader objects
type UnaryCallback = grpc.sendUnaryData<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * A LOCAL Cloud Tasks v2 gRPC server: the real `CloudTasksClient` (and therefore real gax and real
 * grpc-js) talks to it over a real socket, so what it records is what actually went on the wire —
 * the task name, the gRPC deadline of EVERY attempt, the request the customizer produced.
 *
 * It loads the CloudTasks v2 protos shipped inside `@google-cloud/tasks` (plus gax's common protos)
 * and implements only `CreateTask`; each call consumes the next {@link FakeBehavior} in `script`.
 */
export class FakeCloudTasksServer {
    readonly received: ReceivedCreateTask[] = [];
    script: FakeBehavior[] = [];
    port = 0;
    private readonly server = new grpc.Server();

    async start(): Promise<void> {
        const localRequire = createRequire(__filename);
        // .../@google-cloud/tasks/build/cjs/src/index.cjs -> .../build/protos
        const tasksProtos = path.resolve(path.dirname(localRequire.resolve('@google-cloud/tasks')), '../../protos');
        // .../google-gax/build/src/index.js -> .../build/protos (google/api, google/rpc, ...)
        const gaxProtos = path.resolve(path.dirname(localRequire.resolve('google-gax')), '../protos');
        const definition = protoLoader.loadSync('google/cloud/tasks/v2/cloudtasks.proto', {
            includeDirs: [tasksProtos, gaxProtos],
            keepCase: false,
            longs: String,
            enums: String,
            defaults: false,
            oneofs: true,
        });
        const loaded = grpc.loadPackageDefinition(definition);
        const service = this.serviceDefinition(loaded);
        this.server.addService(service, {
            createTask: (call: UnaryCall, callback: UnaryCallback) => this.createTask(call, callback),
        });
        this.port = await new Promise<number>(
            (resolve: (port: number) => void, reject: (error: Error) => void) => {
                this.server.bindAsync(
                    '127.0.0.1:0',
                    grpc.ServerCredentials.createInsecure(),
                    (error: Error | null, port: number) => (error ? reject(error) : resolve(port)),
                );
            },
        );
    }

    /** Every listener and every open call closed, so the suite is clean under --detectOpenHandles. */
    stop(): void {
        this.server.forceShutdown();
    }

    private serviceDefinition(loaded: grpc.GrpcObject): grpc.ServiceDefinition {
        const google = loaded['google'] as grpc.GrpcObject;
        const cloud = google['cloud'] as grpc.GrpcObject;
        const tasks = cloud['tasks'] as grpc.GrpcObject;
        const v2 = tasks['v2'] as grpc.GrpcObject;
        const client = v2['CloudTasks'] as grpc.ServiceClientConstructor;
        return client.service;
    }

    private createTask(call: UnaryCall, callback: UnaryCallback): void {
        const deadline = call.getDeadline();
        const deadlineMs =
            deadline instanceof Date ? deadline.getTime() - Date.now() : Number(deadline) - Date.now();
        const task = call.request.task ?? {};
        const received = new ReceivedCreateTask(
            task.name,
            Number.isFinite(deadlineMs) ? deadlineMs : Infinity,
            task.dispatchDeadline?.seconds,
            task.httpRequest?.headers ?? {},
        );
        this.received.push(received);
        call.on('cancelled', () => {
            received.cancelled = true;
        });
        const behavior = this.script.shift() ?? FakeBehavior.OK;
        switch (behavior) {
            case FakeBehavior.OK:
                callback(null, {
                    name: task.name || `${call.request.parent}/tasks/server-assigned-${this.received.length}`,
                });
                return;
            case FakeBehavior.RESET:
                callback({ code: grpc.status.UNAVAILABLE, details: 'read ECONNRESET' });
                return;
            case FakeBehavior.ALREADY_EXISTS:
                callback({ code: grpc.status.ALREADY_EXISTS, details: 'The task cannot be created because a task with this name existed too recently.' });
                return;
            case FakeBehavior.SILENT:
                return;
        }
    }
}
