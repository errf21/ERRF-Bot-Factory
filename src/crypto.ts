import type { Env } from "./types";
import { assert, AppError } from "./core";
const enc = new TextEncoder();
function encode(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b));
}
function decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
async function key(env: Env, version: string) {
  const keys = JSON.parse(env.MASTER_KEYS) as Record<string, string>;
  const raw = keys[version];
  assert(raw, "KEY_UNAVAILABLE");
  const bytes = decode(raw);
  assert(bytes.length === 32, "INVALID_KEY");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function seal(
  env: Env,
  value: string,
  context: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const version = env.KEY_VERSION;
  assert(/^[a-zA-Z0-9_-]{1,32}$/.test(version), "INVALID_KEY_VERSION");
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(context) },
    await key(env, version),
    enc.encode(value),
  );
  return JSON.stringify({
    v: version,
    iv: encode(iv),
    ct: encode(new Uint8Array(cipher)),
  });
}
export async function open(
  env: Env,
  value: string,
  context: string,
): Promise<string> {
  try {
    const x = JSON.parse(value) as { v: string; iv: string; ct: string };
    const result = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decode(x.iv),
        additionalData: enc.encode(context),
      },
      await key(env, x.v),
      decode(x.ct),
    );
    return new TextDecoder().decode(result);
  } catch {
    throw new AppError("CREDENTIAL_DECRYPT_FAILED", 503);
  }
}
export function secret(): string {
  return encode(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}
