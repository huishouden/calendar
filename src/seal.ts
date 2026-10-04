import { b64url, fromB64, utf8 } from './b64';

/**
 * Sealing records for KV: AES-256-GCM with a key derived (HKDF-SHA-256) from the Worker's
 * `SEAL_KEY` secret and the record's purpose. A feed's record is sealed for `feed:<secret>`, so it
 * opens only with the URL's own secret as well as the Worker's key; a person's record for
 * `person:<pid>`. Neither KV nor its keys hold anything readable.
 */

const keys = new Map<string, Promise<CryptoKey>>();

function keyFor(sealKey: string, purpose: string): Promise<CryptoKey> {
  const id = `${sealKey.length}:${purpose}`;
  let key = keys.get(id);
  if (!key) {
    if (keys.size > 500) keys.clear();
    key = (async () => {
      const raw = fromB64(sealKey.trim().replace(/\+/g, '-').replace(/\//g, '_'));
      if (raw.length < 32) throw new Error('SEAL_KEY must be at least 32 bytes (bun run seal-key).');
      const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: utf8('huishouden-calendar'), info: utf8(purpose) },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    })();
    keys.set(id, key);
  }
  return key;
}

export async function seal(sealKey: string, purpose: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(purpose) }, await keyFor(sealKey, purpose), utf8(JSON.stringify(value)));
  return `v1.${b64url(iv)}.${b64url(sealed)}`;
}

/** The value, or null when it was sealed for another purpose, with another key, or changed. */
export async function unseal<T>(sealKey: string, purpose: string, text: string | null): Promise<T | null> {
  if (!text) return null;
  const [v, iv, sealed] = text.split('.');
  if (v !== 'v1' || !iv || !sealed) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv), additionalData: utf8(purpose) }, await keyFor(sealKey, purpose), fromB64(sealed));
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return null;
  }
}
