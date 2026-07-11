// packages/spi/src/signers.ts
//
// model-supply-greenfield 批次2 slice 1 — the SHARED SIGNER ASPECT (§6:
// 签名算法 is one of the four categories that MUST be code aspects, and the
// signer is a 全通道共享切面). Greenfield rewrite of the legacy engine signers'
// ALGORITHM SEMANTICS (volc SigV4 / tencent TC3 / kling JWT) — no import of
// the old world; `nowMs` injection keeps every signature deterministic in
// tests (the snapshot vectors in test/signers.test.ts are the regression
// baseline the conformance gate reuses).
import { createHash, createHmac } from 'node:crypto';

import type { CredentialInjectionAspect, WireRequestDraft } from './aspects.js';
import { composeWireUrl } from './aspects.js';

// --- signer interface -----------------------------------------------------------

/**
 * The built request a signer signs/decorates. `credentials` are the resolved
 * secret strings (access_key / secret_key / service / region …) — they exist
 * only inside the signing frame. `nowMs` is the injected clock (unix ms) so
 * signing is deterministic under test.
 */
export interface SignerInput {
  method: string;
  /** Full ABSOLUTE request URL (query string included — signers canonicalize it). */
  url: string;
  headers: Record<string, string>;
  /** Serialized request body EXACTLY as it will be sent ('' when bodiless); HMAC strategies hash it. */
  body: string;
  credentials: Record<string, string>;
  nowMs: number;
}

/** A signer returns the (possibly rewritten) URL + the headers to send. */
export interface SignerOutput {
  url: string;
  headers: Record<string, string>;
}

export type Signer = (input: SignerInput) => SignerOutput;

/** Registered signer strategies. Extensible enum — new signature algorithms land here as code aspects (§6: DSL 表达不了签名算法). */
export const SIGNER_STRATEGIES = ['volc-v4', 'tencent-tc3', 'kling-jwt'] as const;
export type SignerStrategy = (typeof SIGNER_STRATEGIES)[number];

// --- shared primitives ------------------------------------------------------------

function sha256hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** `YYYYMMDD'T'HHMMSS'Z'` from unix ms (the SigV4-family X-Date form). */
function basicIsoDate(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/** base64url without padding. */
function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

// --- volc-v4 ------------------------------------------------------------------------

/**
 * Volcengine SignerV4 (HMAC-SHA256). Binds the canonical request — method,
 * path, SORTED query, the four signed headers (content-type / host /
 * x-content-sha256 / x-date), body hash — so the signature is body-dependent
 * and every poll call must be re-signed. The signing-key chain uses the secret
 * key DIRECTLY (no "AWS4" prefix — the volc divergence from AWS SigV4).
 * Credentials: `access_key`/`secret_key` (aliases `ak`/`sk`), `region`
 * (default cn-north-1), `service`.
 */
const volcV4: Signer = (i) => {
  const ak = i.credentials.access_key ?? i.credentials.ak ?? '';
  const sk = i.credentials.secret_key ?? i.credentials.sk ?? '';
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

// --- tencent-tc3 ----------------------------------------------------------------------

/**
 * Tencent Cloud TC3-HMAC-SHA256. Distinct canonicalization from volc (hence a
 * separate signer): canonical URI is always '/', signed headers are exactly
 * `content-type;host`, the credential scope date is `YYYY-MM-DD`, and the
 * signing-key chain PREFIXES the secret with "TC3". Emits `X-TC-Timestamp`
 * (unix seconds). Credentials: `access_key`/`secret_key` (alias `secret_id`
 * for the id), `service`.
 */
const tencentTc3: Signer = (i) => {
  const secretId = i.credentials.access_key ?? i.credentials.secret_id ?? '';
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

// --- kling-jwt ------------------------------------------------------------------------

/**
 * Kling: a fresh HS256 JWT per request — `{ iss: access_key, exp: now+1800,
 * nbf: now-5 }` signed with the secret key → `Authorization: Bearer {jwt}`
 * (30-minute TTL). Body-independent; URL untouched. Credentials:
 * `access_key`/`secret_key` (aliases `ak`/`sk`).
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

/** The named signer registry (§6: 签名器为全通道共享切面). */
export const SIGNERS: Record<SignerStrategy, Signer> = {
  'volc-v4': volcV4,
  'tencent-tc3': tencentTc3,
  'kling-jwt': klingJwt,
};

// --- credential-injection convenience wrapper ---------------------------------------

/** Read an optional string knob (e.g. `service` / `region`) from the dialect config bag. */
function configString(
  config: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = config?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The body string a signature binds — EXACTLY what the transport will send.
 * `json` drafts serialize via `JSON.stringify` (the same serialization the
 * default transport's HttpClient applies); bodiless drafts sign ''.
 * `form`/`multipart` drafts cannot be signed byte-faithfully here — a dialect
 * needing that pairs a custom serializer with a custom transport.
 */
function signableBody(draft: WireRequestDraft): string {
  if (draft.bodyKind === 'none' || draft.body === undefined) return '';
  if (draft.bodyKind === 'json') return JSON.stringify(draft.body);
  throw new TypeError(
    `signerCredentialInjection cannot sign a "${draft.bodyKind}" body byte-faithfully; use a custom CredentialInjectionAspect + TransportAspect`,
  );
}

/**
 * Wrap a signer strategy as a ready-made aspect ③ (§6-③: 签名类方言在此调共享
 * 签名器). Maps the channel's `ak_sk` structured secret (§2.3 credential
 * schema) to the signer credential bag — `region` falls back from the secret
 * to `ctx.config.region`; `service` (volc/tencent scope component) comes from
 * `ctx.config.service`. Runs at pipeline step ③, when `draft.path` is already
 * absolute, so the signature binds the exact URL the transport will hit.
 */
export function signerCredentialInjection(strategy: SignerStrategy): CredentialInjectionAspect {
  return {
    injectCredential(draft, secret, ctx) {
      if (secret.scheme !== 'ak_sk') {
        throw new TypeError(
          `signer strategy "${strategy}" requires an ak_sk credential secret; got scheme "${secret.scheme}"`,
        );
      }
      const credentials: Record<string, string> = {
        access_key: secret.access_key,
        secret_key: secret.secret_key,
      };
      const region = secret.region ?? configString(ctx.config, 'region');
      if (region !== undefined) credentials.region = region;
      const service = configString(ctx.config, 'service');
      if (service !== undefined) credentials.service = service;

      const signed = SIGNERS[strategy]({
        method: draft.method,
        url: composeWireUrl(draft),
        headers: { ...(draft.headers ?? {}) },
        body: signableBody(draft),
        credentials,
        nowMs: ctx.nowMs,
      });

      // Defensive URL write-back: none of the registered strategies rewrite the
      // URL today, but the Signer contract allows it (query-key style), so a
      // rewritten URL is split back into path + query rather than dropped.
      const rewritten = new URL(signed.url);
      const query: Record<string, string> = {};
      for (const [key, value] of rewritten.searchParams.entries()) query[key] = value;
      rewritten.search = '';
      return {
        ...draft,
        path: rewritten.toString(),
        query,
        headers: signed.headers,
      };
    },
  };
}
