import { StreamTransportError } from '@webpieces/core-util';
import { Utf8Codec } from './Utf8Codec';

/** One fully delimited Server-Sent Event. `data:` fields are joined with a newline. */
export class SseEvent {
    constructor(
        public readonly data: string,
        public readonly event?: string,
    ) {}
}

/** Incremental SSE parser. It deliberately ignores comments, id, retry and unknown fields. */
export class SseEventParser {
    private readonly decoder = new Utf8Codec();
    private buffered = '';
    private eventName: string | undefined;
    private dataLines: string[] = [];

    feed(bytes: Uint8Array | string): SseEvent[] {
        this.buffered += typeof bytes === 'string' ? bytes : this.decoder.decode(bytes, true);
        return this.drainLines(false);
    }

    finish(): SseEvent[] {
        this.buffered += this.decoder.decode(undefined, false);
        return this.drainLines(true);
    }

    private drainLines(finished: boolean): SseEvent[] {
        const events: SseEvent[] = [];
        let newline = this.buffered.indexOf('\n');
        while (newline >= 0) {
            const rawLine = this.buffered.slice(0, newline);
            this.buffered = this.buffered.slice(newline + 1);
            this.acceptLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine, events);
            newline = this.buffered.indexOf('\n');
        }
        if (finished && this.buffered !== '') {
            const rawLine = this.buffered;
            this.buffered = '';
            this.acceptLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine, events);
        }
        if (finished && this.dataLines.length > 0) {
            throw new StreamTransportError('SSE response ended in the middle of an event.');
        }
        return events;
    }

    private acceptLine(line: string, events: SseEvent[]): void {
        if (line === '') {
            if (this.dataLines.length > 0) {
                events.push(new SseEvent(this.dataLines.join('\n'), this.eventName));
            }
            this.dataLines = [];
            this.eventName = undefined;
            return;
        }
        if (line.startsWith(':')) return;
        const separator = line.indexOf(':');
        const field = separator < 0 ? line : line.slice(0, separator);
        let value = separator < 0 ? '' : line.slice(separator + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') this.dataLines.push(value);
        if (field === 'event') this.eventName = value;
    }
}
