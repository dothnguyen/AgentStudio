const encoder = new TextEncoder();

/** UTF-8 byte length of a string, which is what the backend limits count. */
export function textBytes(text: string): number {
  return encoder.encode(text).byteLength;
}

/** Number of lines in a text; an empty text has no lines. */
export function textLines(text: string): number {
  return text === '' ? 0 : text.split('\n').length;
}

/** Characters (code points), used by the member page's prompt counter. */
export function textCharacters(text: string): number {
  return Array.from(text).length;
}

/** "n lines · n / limit bytes", with both numbers grouped for readability. */
export function textByteCountText(text: string, limit: number): string {
  return `${textLines(text)} lines · ${textBytes(text).toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} bytes`;
}
