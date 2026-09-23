import { createHash } from 'node:crypto';

/** Never log arbitrary error messages: SDK errors can include tokens or payloads. */
export function safeRuntimeError(error: unknown): { name: string; fingerprint: string; frames: string[] } {
  const e = error as any;
  let message = '';
  let stack = '';
  let name = 'Error';
  try {
    message = String(e?.message ?? e?.errMsg ?? '');
    stack = String(e?.stack ?? '');
    if (/^[A-Za-z][A-Za-z0-9]*Error$|^Error$/.test(e?.name)) name = e.name;
  } catch { /* Exotic thrown objects must not break diagnostics. */ }
  // Keep only file/line locations, not arbitrary function names or URL queries.
  const frames = stack.split('\n').slice(1).flatMap(line => {
    const match = line.match(/(?:\(|\s)((?:file:\/\/)?\/[^\s()?]+|node:[\w/.-]+):(\d+):(\d+)\)?$/);
    return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
  }).slice(0, 8);
  return { name, fingerprint: createHash('sha256').update(`${name}:${message}:${frames.join('|')}`).digest('hex').slice(0, 16), frames };
}
