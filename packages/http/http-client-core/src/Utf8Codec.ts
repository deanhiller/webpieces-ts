/** Small dependency-free UTF-8 codec for browser, Node, and React Native bundles. */
export class Utf8Codec {
    private pending: number[] = [];

    encode(value: string): Uint8Array {
        const bytes: number[] = [];
        for (const character of value) {
            const point = character.codePointAt(0) ?? 0;
            if (point <= 0x7f) {
                bytes.push(point);
            } else if (point <= 0x7ff) {
                bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
            } else if (point <= 0xffff) {
                bytes.push(
                    0xe0 | (point >> 12),
                    0x80 | ((point >> 6) & 0x3f),
                    0x80 | (point & 0x3f),
                );
            } else {
                bytes.push(
                    0xf0 | (point >> 18),
                    0x80 | ((point >> 12) & 0x3f),
                    0x80 | ((point >> 6) & 0x3f),
                    0x80 | (point & 0x3f),
                );
            }
        }
        return Uint8Array.from(bytes);
    }

    decode(bytes?: Uint8Array, stream = false): string {
        const input = [...this.pending, ...(bytes ?? [])];
        this.pending = [];
        let output = '';
        let index = 0;
        while (index < input.length) {
            const first = input[index];
            const length =
                first <= 0x7f
                    ? 1
                    : first >= 0xc2 && first <= 0xdf
                      ? 2
                      : first >= 0xe0 && first <= 0xef
                        ? 3
                        : first >= 0xf0 && first <= 0xf4
                          ? 4
                          : 0;
            if (length === 0) {
                output += '\ufffd';
                index++;
                continue;
            }
            if (index + length > input.length) {
                if (stream) this.pending = input.slice(index);
                else output += '\ufffd';
                break;
            }
            let point = length === 1 ? first : first & (0x7f >> length);
            let valid = true;
            for (let offset = 1; offset < length; offset++) {
                const continuation = input[index + offset];
                if ((continuation & 0xc0) !== 0x80) {
                    valid = false;
                    break;
                }
                point = (point << 6) | (continuation & 0x3f);
            }
            const minimum = length === 1 ? 0 : length === 2 ? 0x80 : length === 3 ? 0x800 : 0x10000;
            if (
                !valid ||
                point < minimum ||
                point > 0x10ffff ||
                (point >= 0xd800 && point <= 0xdfff)
            ) {
                output += '\ufffd';
                index++;
                continue;
            }
            output += String.fromCodePoint(point);
            index += length;
        }
        return output;
    }
}
