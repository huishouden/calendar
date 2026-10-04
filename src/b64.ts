const enc = new TextEncoder();

export const utf8 = (s: string): Uint8Array => enc.encode(s);

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** SHA-256 as base64url. */
export async function sha256(text: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', utf8(text)));
}

/** A random secret: `bytes` random bytes, base64url. */
export const randomSecret = (bytes = 32): string => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

const B32HEX = '0123456789abcdefghijklmnopqrstuv';

/** Base32hex, lowercase, no padding: the alphabet Google Calendar event ids allow. */
export function base32hex(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32HEX[(value << (5 - bits)) & 31];
  return out;
}
