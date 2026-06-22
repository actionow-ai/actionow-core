import { createHash, createHmac } from 'node:crypto';

import type { SignerStrategy } from '@actionow/contracts';

/**
 * The built request a signer signs/decorates. `credentials` are the resolved
 * secrets (api_key / ak / sk …) — they appear ONLY here, in the platform layer
 * OUTSIDE the QuickJS handler sandbox (spec D5/D7). `nowMs` is injected so signing
 * is deterministic in tests.
 */
export interface SignerInput {
  method: string;
  /** Full request URL (may carry a query string). */
  url: string;
  headers: Record<string, string>;
  /** Serialized request body (signed by HMAC strategies; '' for GET). */
  body: string;
  credentials: Record<string, string>;
  nowMs: number;
}

/** A signer returns the (possibly URL-rewritten) request + the headers to send. */
export interface SignerOutput {
  url: string;
  headers: Record<string, string>;
}

export type Signer = (input: SignerInput) => SignerOutput;

function sha256hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}
/** YYYYMMDD'T'HHMMSS'Z' from unix ms (SigV4-family X-Date). */
function basicIsoDate(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[:-]|\.\d{3}/g, '');
}

// ---------------------------------------------------------------- simple
const bearer: Signer = (i) => ({
  url: i.url,
  headers: { ...i.headers, Authorization: `Bearer ${i.credentials.api_key ?? ''}` },
});

/** Header name from `credentials.header_name` (e.g. x-api-key, xi-api-key); default x-api-key. */
const customHeader: Signer = (i) => ({
  url: i.url,
  headers: {
    ...i.headers,
    [i.credentials.header_name ?? 'x-api-key']: i.credentials.api_key ?? '',
  },
});

/** Append `?key=` (Gemini-style). Rewrites the URL; leaves headers untouched. */
const queryKey: Signer = (i) => {
  const u = new URL(i.url);
  u.searchParams.set(i.credentials.query_param ?? 'key', i.credentials.api_key ?? '');
  return { url: u.toString(), headers: { ...i.headers } };
};

/** Literal `Authorization: Token {key}` (Vidu) — NOT Bearer. */
const token: Signer = (i) => ({
  url: i.url,
  headers: { ...i.headers, Authorization: `Token ${i.credentials.api_key ?? ''}` },
});

const none: Signer = (i) => ({ url: i.url, headers: { ...i.headers } });

// ---------------------------------------------------------------- klingJwt
/** base64url without padding. */
function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}
/**
 * Kling: a fresh HS256 JWT per request — `{ iss: ak, exp: now+1800, nbf: now-5 }`
 * signed with the secret key → `Authorization: Bearer {jwt}`. 30-min TTL.
 */
const klingJwt: Signer = (i) => {
  const ak = i.credentials.access_key ?? i.credentials.ak ?? '';
  const sk = i.credentials.secret_key ?? i.credentials.sk ?? '';
  const nowSec = Math.floor(i.nowMs / 1000);
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(
    Buffer.from(JSON.stringify({ iss: ak, exp: nowSec + 1800, nbf: nowSec - 5 })),
  );
  const signature = b64url(createHmac('sha256', sk).update(`${header}.${payload}`).digest());
  return {
    url: i.url,
    headers: { ...i.headers, Authorization: `Bearer ${header}.${payload}.${signature}` },
  };
};

// ---------------------------------------------------------------- volcSignV4
/**
 * Volcengine SignerV4 (HMAC-SHA256). Binds the canonical request (method, path,
 * sorted query, signed headers, body hash) — so the signature is body-dependent
 * and a poll call MUST be re-signed. Credentials: `ak`/`sk`/`region`/`service`.
 * NOTE: the signing-key chain uses the secret key directly (no "AWS4" prefix).
 */
const volcSignV4: Signer = (i) => {
  const ak = i.credentials.ak ?? i.credentials.access_key_id ?? '';
  const sk = i.credentials.sk ?? i.credentials.secret_access_key ?? '';
  const region = i.credentials.region ?? 'cn-north-1';
  const service = i.credentials.service ?? '';
  const u = new URL(i.url);
  const xDate = basicIsoDate(i.nowMs);
  const shortDate = xDate.slice(0, 8);
  const payloadHash = sha256hex(i.body);
  const contentType = i.headers['content-type'] ?? i.headers['Content-Type'] ?? 'application/json';

  const canonicalQuery = [...u.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const signedMap: Record<string, string> = {
    'content-type': contentType,
    host: u.host,
    'x-content-sha256': payloadHash,
    'x-date': xDate,
  };
  const signedKeys = Object.keys(signedMap).sort();
  const canonicalHeaders = signedKeys.map((k) => `${k}:${signedMap[k]?.trim() ?? ''}\n`).join('');
  const signedHeaders = signedKeys.join(';');

  const canonicalRequest = [
    i.method.toUpperCase(),
    u.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, sha256hex(canonicalRequest)].join(
    '\n',
  );

  const kDate = hmac(sk, shortDate);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    url: i.url,
    headers: {
      ...i.headers,
      'Content-Type': contentType,
      Host: u.host,
      'X-Date': xDate,
      'X-Content-Sha256': payloadHash,
      Authorization: authorization,
    },
  };
};

// ---------------------------------------------------------------- tencentTC3
/**
 * Tencent Cloud TC3-HMAC-SHA256. Distinct canonicalization from Volcengine (so a
 * separate signer): canonical URI '/', `content-type;host` signed headers, the
 * signing-key chain prefixes the secret with "TC3". Credentials: `secret_id`/
 * `secret_key`/`service`.
 */
const tencentTC3: Signer = (i) => {
  const secretId = i.credentials.secret_id ?? '';
  const secretKey = i.credentials.secret_key ?? '';
  const service = i.credentials.service ?? '';
  const u = new URL(i.url);
  const nowSec = Math.floor(i.nowMs / 1000);
  const date = new Date(i.nowMs).toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const contentType = i.headers['content-type'] ?? i.headers['Content-Type'] ?? 'application/json';

  const canonicalQuery = u.search.startsWith('?') ? u.search.slice(1) : '';
  const canonicalHeaders = `content-type:${contentType}\nhost:${u.host}\n`;
  const signedHeaders = 'content-type;host';
  const payloadHash = sha256hex(i.body);
  const canonicalRequest = [
    i.method.toUpperCase(),
    '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(nowSec),
    credentialScope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    url: i.url,
    headers: {
      ...i.headers,
      'Content-Type': contentType,
      Host: u.host,
      'X-TC-Timestamp': String(nowSec),
      Authorization: authorization,
    },
  };
};

/** The named signer registry (spec §4.5). */
export const SIGNERS: Record<SignerStrategy, Signer> = {
  bearer,
  'custom-header': customHeader,
  'query-key': queryKey,
  token,
  klingJwt,
  volcSignV4,
  tencentTC3,
  none,
};

/** Apply a named signer strategy to a built request. Keys live only in `input.credentials`. */
export function applySigner(strategy: SignerStrategy, input: SignerInput): SignerOutput {
  return SIGNERS[strategy](input);
}
