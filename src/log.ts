/**
 * One JSON line per thing that happened, with counts and outcomes only: never a title, an email, a
 * household or a token. Cloudflare's Workers Observability keeps them (`wrangler tail`).
 */
export type LogFields = Record<string, string | number | boolean | undefined>;

let sink: (line: string) => void = (line) => console.log(line);

export function log(event: string, fields: LogFields = {}): void {
  sink(JSON.stringify({ event, ...fields }));
}

/** For tests: capture the lines. */
export function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const before = sink;
  sink = (line) => lines.push(line);
  return { lines, restore: () => (sink = before) };
}
