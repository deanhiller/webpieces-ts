import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';
import { StageOutputLog } from './stage-output-log';

/** Reads newly appended build-log bytes and mirrors them to the human's terminal until stopped. */
export class BuildLogFollower {
    private offset = 0;
    private timer: NodeJS.Timeout | null = null;
    private readonly decoder = new StringDecoder('utf8');

    constructor(
        private readonly logPath: string,
        private readonly stageConsole: StageOutputLog,
    ) {}

    start(): void {
        this.timer = setInterval((): void => this.flush(), 100);
    }

    stop(): void {
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        this.flush();
        const remaining = this.decoder.end();
        if (remaining !== '') this.stageConsole.say(remaining);
    }

    private flush(): void {
        if (!fs.existsSync(this.logPath)) return;
        const size = fs.statSync(this.logPath).size;
        if (size <= this.offset) return;
        const length = size - this.offset;
        const buffer = Buffer.alloc(length);
        const fd = fs.openSync(this.logPath, 'r');
        const bytesRead = fs.readSync(fd, buffer, 0, length, this.offset);
        fs.closeSync(fd);
        this.offset += bytesRead;
        const text = this.decoder.write(buffer.subarray(0, bytesRead));
        if (text !== '') this.stageConsole.say(text);
    }
}
