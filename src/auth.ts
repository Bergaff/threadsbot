/**
 * Создание и верификация HMAC токена для бесшовной связки Telegram <-> Веб-сайт
 */
export async function createAuthToken(userId: number, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret || "fallback_threads_secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const data = enc.encode(`threads_auth:${userId}`);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
  return `${userId}.${hex}`;
}

export async function verifyAuthToken(token: string, secret: string): Promise<number | null> {
  if (!token || !token.includes(".")) return null;
  const [uidStr, sig] = token.split(".");
  const uid = Number(uidStr);
  if (!uid || isNaN(uid) || !sig) return null;
  const expected = await createAuthToken(uid, secret);
  return token === expected ? uid : null;
}
