import { Writable } from 'stream';
import Logger from 'bunyan';
import { LoggingBunyan } from '@google-cloud/logging-bunyan';
import { ApiCallLogName } from '@webpieces/core-util';
import { LoggedError } from './LoggedError';
import { ChunkingRawStream } from './ChunkingRawStream';

// A parsed bunyan JSON record: standard fields plus arbitrary injected context
// tags. Values are whatever JSON holds.
type JsonValue = string | number | boolean | object | null;
type BunyanRecord = Record<string, JsonValue>;

// The two context keys rendered SPECIALLY (as the compact `[Controller.method]` bracket) rather than
// as `key:value` tags — they name WHICH CODE ran, the thing you grep for. Kept in sync with
// WebpiecesCoreHeaders.CONTROLLER / .METHOD by name. They are excluded from the generic tag loop.
const CONTROLLER_FIELD = 'controller';
const METHOD_FIELD = 'method';

// bunyan record fields that are structural / rendered specially, so they are not
// shown as context tags in the local console line.
//
// `name` (the service) and `version` (the build) are ServiceInfo base fields riding on EVERY
// record. They earn their keep in GCP, where you filter across many services and deploys, but
// locally each service logs to its own place and you can check git yourself — so as a tag on every
// single line they are pure noise. Listing them here is the bunyan twin of winston's
// LOCAL_STRUCTURAL_KEYS; GCP still gets both (that stream does its own formatting).
//
// `loggerName` (its own `[…]` bracket) and `controller`/`method` (the `[Controller.method]` bracket)
// are rendered specially too, so they are excluded here from the generic `key:value` tag loop.
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
    CONTROLLER_FIELD,
    METHOD_FIELD,
]);

// "HH:MM:SS.mmm" in LOCAL time — matching the winston backend (fecha 'HH:mm:ss.SSS') and the trytami
// format this was tuned for (`Date.toTimeString()`, also local). Parsing the ISO to a Date and reading
// local fields (rather than splitting the UTC ISO string) is what keeps the two backends byte-identical;
// milliseconds are zero-padded to 3 digits (trytami's raw `getMilliseconds()` rendered 5ms as ".5").
// webpieces-disable no-function-outside-class -- bunyan render helper; whole file is bunyan stream/render factories
function formatTime(iso: JsonValue): string {
    if (typeof iso !== 'string') {
        return '';
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
        return iso;
    }
    const p2 = (n: number): string => String(n).padStart(2, '0');
    const p3 = (n: number): string => String(n).padStart(3, '0');
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
}

// The compact `[Controller.method]` bracket (or `[Controller]`, or '' when neither is present, e.g. a
// startup / static / pre-route line). Empty controller drops the whole bracket.
// webpieces-disable no-function-outside-class -- bunyan render helper; whole file is bunyan stream/render factories
function formatControllerMethod(controller: JsonValue, method: JsonValue): string {
    if (typeof controller !== 'string' || controller.length === 0) {
        return '';
    }
    const suffix = typeof method === 'string' && method.length > 0 ? `.${method}` : '';
    return `[${controller}${suffix}]`;
}

// Build the ordered `key:value` context tags. When `fields` is given it is an app-chosen ALLOW-LIST:
// only those keys render, in that order (specials skipped). When absent, every non-structural string
// field renders in record order. Empty/object-valued fields are dropped either way.
// webpieces-disable no-function-outside-class -- bunyan render helper; whole file is bunyan stream/render factories
function buildTags(obj: BunyanRecord, fields?: string[]): string[] {
    const tags: string[] = [];
    const push = (key: string): void => {
        const value = obj[key];
        if (typeof value === 'object' || value == null) {
            return;
        }
        const str = String(value);
        if (str.length === 0) {
            return;
        }
        tags.push(`${key}:${str}`);
    };
    if (fields) {
        for (const key of fields) {
            if (key === CONTROLLER_FIELD || key === METHOD_FIELD || key === 'loggerName') {
                continue;
            }
            push(key);
        }
    } else {
        for (const key of Object.keys(obj)) {
            if (BUNYAN_STD_FIELDS.has(key)) {
                continue;
            }
            push(key);
        }
    }
    return tags;
}

/**
 * Render one bunyan JSON line as a human-readable, greppable console line:
 * `[LEVEL][time][Controller.method][loggerName][ctx tags]: message` plus multi-line error details.
 * Level FIRST, then time (the ordering the trytami format was tuned for). `controller`/`method` render
 * as a compact bracket, `loggerName` as its own bracket, and every other injected context key becomes a
 * `key:value` tag (optionally filtered/ordered by the app `fields` allow-list).
 */
// webpieces-disable no-function-outside-class -- bunyan render helper; whole file is bunyan stream/render factories
function writeConsole(line: string, fields?: string[]): void {
    const obj: BunyanRecord = JSON.parse(line);
    const levelName = (Logger.nameFromLevel[obj['level'] as number] ?? 'info').toUpperCase().padEnd(5);
    const time = formatTime(obj['time']);

    const controllerMethod = formatControllerMethod(obj[CONTROLLER_FIELD], obj[METHOD_FIELD]);
    // LogApiCall lines render as a self-describing [API.{side}.{phase}] bracket instead of the opaque
    // [LogApiCall]; every other line keeps its plain [loggerName] bracket.
    const loggerBracket = ApiCallLogName.bracket(obj['loggerName'], obj['api']);

    const tags = buildTags(obj, fields);
    const tagStr = tags.length > 0 ? tags.join(', ') : 'no-context';

    let message = `[${levelName}][${time}]${controllerMethod}${loggerBracket}[${tagStr}]: ${String(obj['msg'] ?? '')}`;

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
 * Records pass through a {@link ChunkingRawStream} first, because Cloud Logging caps a LogEntry at
 * 256 KiB and rejects the whole `entries.write` call when one entry exceeds it — so a single fat
 * response body or stack trace can take a batch of good entries down with it. Oversized records are
 * SPLIT into several complete records sharing a `logChunk.uid` rather than lost or truncated.
 *
 * We do NOT filter by level — that is bunyan's job. The stream is created at
 * bunyan's default level ('info'); there is no webpieces level knob.
 */
// webpieces-disable no-function-outside-class -- bunyan Stream factory; whole file is bunyan stream/render factories
export function createGoogleCloudStream(): Logger.Stream {
    const loggingBunyan = new LoggingBunyan();
    // stream('info') returns { level, type: 'raw', stream: loggingBunyan } — we keep bunyan's raw
    // contract and only interpose on the stream it writes records to.
    const gcp = loggingBunyan.stream('info');
    return {
        level: gcp.level,
        type: 'raw',
        stream: new ChunkingRawStream(loggingBunyan),
    };
}

/**
 * The local dev stream: human-readable text to stdout via {@link writeConsole}.
 * No level is set — bunyan filters at its own default ('info').
 *
 * `consoleFields`, when given, is the app-chosen ordered ALLOW-LIST of context keys to render in the
 * console line (hides noise like `requestPath` locally while GCP still gets every logged key). When
 * omitted, every non-structural context key renders in record order.
 */
// webpieces-disable no-function-outside-class -- bunyan Stream factory; whole file is bunyan stream/render factories
export function createConsoleStream(consoleFields?: string[]): Logger.Stream {
    const writable = new Writable({
        write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
            writeConsole(chunk.toString(), consoleFields);
            callback();
        },
    });
    return {
        name: 'console',
        stream: writable,
    };
}
