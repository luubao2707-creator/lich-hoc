// Gửi Web Push không cần thư viện: mã hóa nội dung theo RFC 8291 (aes128gcm)
// và xác thực máy chủ bằng VAPID (RFC 8292). Chỉ dùng WebCrypto có sẵn trong Workers.

const enc = new TextEncoder();

export function b64u(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts) {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let i = 0;
  for (const a of arrays) { out.set(a, i); i += a.length; }
  return out;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// ---------- Khóa VAPID (tự tạo lần đầu, lưu trong bảng meta) ----------

/** Trả về { publicKey: base64url 65 byte, privateKey: CryptoKey }. */
export async function getVapid(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'vapid'").first();
  let stored = row ? JSON.parse(row.value) : null;
  if (!stored) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    stored = {
      publicKey: b64u(await crypto.subtle.exportKey('raw', pair.publicKey)),
      privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    };
    // INSERT OR IGNORE: nếu hai lần chạy cùng tạo khóa, chỉ một khóa được giữ.
    await env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('vapid', ?1)").bind(JSON.stringify(stored)).run();
    stored = JSON.parse((await env.DB.prepare("SELECT value FROM meta WHERE key = 'vapid'").first()).value);
  }
  const privateKey = await crypto.subtle.importKey('jwk', stored.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return { publicKey: stored.publicKey, privateKey };
}

/** Header Authorization theo VAPID: "vapid t=<JWT>, k=<public key>". */
export async function vapidHeader(endpoint, vapid, subject, now = Date.now()) {
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600, // Apple yêu cầu ≤ 24 giờ
    sub: subject,
  })));
  const unsigned = `${header}.${claims}`;
  // WebCrypto trả chữ ký dạng r||s (64 byte) – đúng định dạng ES256 của JWT.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.privateKey, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// ---------- Mã hóa nội dung (RFC 8291) ----------

/**
 * Mã hóa payload cho một thiết bị. p256dh, auth: base64url từ PushSubscription.keys.
 * salt / serverKeys chỉ truyền vào khi kiểm thử.
 */
export async function encryptPayload(payload, p256dh, auth, { salt, serverKeys } = {}) {
  const uaPublic = fromB64u(p256dh);   // khóa công khai của trình duyệt (65 byte)
  const authSecret = fromB64u(auth);   // 16 byte
  const as = serverKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  // IKM = HKDF(salt = auth, ikm = ecdh, info = "WebPush: info\0" || ua_public || as_public, 32)
  const prkKey = await hmac(authSecret, ecdhSecret);
  const ikm = (await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, [1]))).slice(0, 32);

  const saltBytes = salt || crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(saltBytes, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), [1]))).slice(0, 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plaintext = concat(payload, [2]); // 0x02 = bản ghi cuối, không đệm
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, plaintext));

  // Header: salt (16) | record size (4, = 4096) | độ dài keyid (1, = 65) | keyid = as_public
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(saltBytes, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

/**
 * Gửi một thông báo. subscription: PushSubscription JSON ({ endpoint, keys: { p256dh, auth } }).
 * Trả về mã HTTP của dịch vụ push (201 = thành công; 404 / 410 = đăng ký đã hết hạn).
 */
export async function sendPush(env, subscription, message, vapid) {
  const v = vapid || await getVapid(env);
  const body = await encryptPayload(enc.encode(JSON.stringify(message)), subscription.keys.p256dh, subscription.keys.auth);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(subscription.endpoint, v, env.VAPID_SUBJECT || 'https://example.com'),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
    },
    body,
  });
  return res.status;
}
