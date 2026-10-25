// Web Push for NIR Markets price alerts, with nothing but node:crypto:
// VAPID identifies the server to the browser's push service (RFC 8292) and
// the message is encrypted for the browser alone (RFC 8291, aes128gcm), so
// the push service only ever carries ciphertext.
//
// The VAPID key pair is made once and kept in the accounts database; the
// public half goes to the page, which hands it to pushManager.subscribe().
import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";

const b64 = (buffer) => Buffer.from(buffer).toString("base64url");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

// A new P-256 key pair as { publicKey: base64url of the raw 65-byte point, privateJwk }.
export function createVapidKeys() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  return { publicKey: b64(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")])), privateJwk: jwk };
}

// The Authorization header value for one push service, valid for 12 hours.
export function vapidAuthorization(endpoint, keys, subject, now = Date.now()) {
  const header = b64(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const key = createPrivateKey({ key: keys.privateJwk, format: "jwk" });
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${keys.publicKey}`;
}

// The message encrypted for one subscription ({ keys: { p256dh, auth } }), as one aes128gcm record.
export function encryptPayload(subscription, payload, { salt = randomBytes(16), ecdh = null } = {}) {
  const receiver = Buffer.from(subscription.keys.p256dh, "base64url");
  const auth = Buffer.from(subscription.keys.auth, "base64url");
  if (receiver.length !== 65 || auth.length !== 16) throw new Error("subscription keys are invalid");
  // A fresh key pair for every message, unless a test passes its own.
  const local = ecdh ?? createECDH("prime256v1");
  if (!ecdh) local.generateKeys();
  const sender = local.getPublicKey();
  const shared = local.computeSecret(receiver);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from("WebPush: info\0"), receiver, sender, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // The 0x02 byte marks the last (and only) record.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head[20] = sender.length;
  return Buffer.concat([head, sender, body]);
}

// Sends one message; answers "sent", "gone" (the subscription has expired and should be dropped) or "failed".
export async function sendPush(subscription, message, { keys, subject, fetch: post = fetch, now = Date.now() } = {}) {
  try {
    const response = await post(subscription.endpoint, {
      method: "POST",
      headers: { "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "high",
        authorization: vapidAuthorization(subscription.endpoint, keys, subject, now) },
      body: encryptPayload(subscription, JSON.stringify(message)),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404 || response.status === 410) return "gone";
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
