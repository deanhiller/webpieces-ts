import { Writable } from 'stream';
import Logger from 'bunyan';
import { LoggingBunyan } from '@google-cloud/logging-bunyan';
import { LoggedError } from './LoggedError';

// A parsed bunyan JSON record: standard fields plus arbitrary injected context
// tags. Values are whatever JSON holds.
type JsonValue = string | number | boolean | object | null;
type BunyanRecord = Record<string, JsonValue>;

// bunyan record fields that are structural / rendered specially, so they are not
// shown as context tags in the local console line.
//
// `name` (the service) and `version` (the build) are ServiceInfo base fields riding on EVERY
// record. They earn their keep in GCP, where you filter across many services and deploys, but
// locally each service logs to its own place and you can check git yourself — so as a tag on every
// single line they are pure noise. Listing them here is the bunyan twin of winston's
// LOCAL_STRUCTURAL_KEYS; GCP still gets both (that stream does its own formatting).
const BUNYAN_STD_FIELDS = new Set<string>([
    'v',
    'level',
    'name',
    'version',
    'hostname',
    'pid',
    'time',
    'msg',
    'src',
    'err',
    'loggerName',
]);

function formatTime(iso: JsonValue): string {
    if (typeof iso !== 'string') {
        return '';
    }
    // ISO 8601 "2026-07-08T12:34:56.789Z" → "12:34:56.789"
    const timePart = iso.split('T')[1];
    return timePart ? timePart.replace('Z', '') : iso;
}

/**
 * Render one bunyan JSON line as a human-readable, greppable console line:
 * `[LEVEL][time][ctx tags]: message` plus multi-line error details. Ported from
 * the tested trytami writeConsole, generalized: every non-structural field
 * (i.e. the injected context keys) becomes a `key:value` tag.
 */
function writeConsole(line: string): void {
    const obj: BunyanRecord = JSON.parse(line);
    const levelName = (Logger.nameFromLevel[obj['level'] as number] ?? 'info').toUpperCase().padEnd(5);
    const time = formatTime(obj['time']);

    const tags: string[] = [];
    if (obj['loggerName']) {
        tags.push(`logger:${String(obj['loggerName'])}`);
    }
    for (const key of Object.keys(obj)) {
        if (BUNYAN_STD_FIELDS.has(key)) {
            continue;
        }
        tags.push(`${key}:${String(obj[key])}`);
    }
    const tagStr = tags.length > 0 ? tags.join(', ') : 'no-context';

    let message = `[${levelName}][${time}][${tagStr}]: ${String(obj['msg'] ?? '')}`;

    const err = obj['err'] as LoggedError | undefined;
    if (err) {
        message += `\nError Details:`;
        message += `\n  Message: ${err.message}`;
        message += `\n  Name: ${err.name}`;
        if (err.stack) {
            message += `\n  Stack Trace:\n${err.stack}`;
        }
    }

    // This IS a logging backend (the console sink); direct stdout is intentional.
    console.log(message);
}

/**
 * The GCP stream: delegates ALL structured-JSON formatting (numeric level → GCP
 * severity, msg→message, trace/httpRequest fields, stripping name/hostname/pid)
 * to @google-cloud/logging-bunyan, exactly as the tested trytami service does.
 * Sends to the Cloud Logging API (needs ADC on the instance).
 *
 * We do NOT filter by level — that is bunyan's job. The stream is created at
 * bunyan's default level ('info'); there is no webpieces level knob.
 */
// webpieces-disable no-function-outside-class -- bunyan Stream factory; whole file is bunyan stream/render factories
export function createGoogleCloudStream(): Logger.Stream {
    const loggingBunyan = new LoggingBunyan();
    return loggingBunyan.stream('info');
}

/**
 * The local dev stream: human-readable text to stdout via {@link writeConsole}.
 * No level is set — bunyan filters at its own default ('info').
 */
// webpieces-disable no-function-outside-class -- bunyan Stream factory; whole file is bunyan stream/render factories
export function createConsoleStream(): Logger.Stream {
    const writable = new Writable({
        write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
            writeConsole(chunk.toString());
            callback();
        },
    });
    return {
        name: 'console',
        stream: writable,
    };
}
