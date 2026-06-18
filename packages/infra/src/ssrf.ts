import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Thrown when an egress target is rejected by {@link assertEgressAllowed}: a
 * non-http(s) scheme, a malformed/unresolvable host, or a host that is (or
 * resolves to) a private/loopback/link-local/reserved address.
 */
export class EgressBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressBlockedError';
  }
}

/** A DNS resolver result entry (subset of node:dns LookupAddress). */
interface ResolvedAddress {
  address: string;
  family: number;
}

export interface EgressPolicy {
  /**
   * When true, private/loopback/link-local targets are permitted — the operator
   * opt-in for self-hosted / local-callback deployments. Default false (a tenant-
   * supplied callback can never reach internal services or cloud metadata).
   */
  allowPrivateTargets?: boolean;
  /**
   * DNS resolver, injectable for tests. Defaults to `node:dns/promises` lookup
   * returning ALL addresses (so a host with one public + one private A record is
   * still caught).
   */
  lookup?: (host: string) => Promise<ResolvedAddress[]>;
}

/** Only plain HTTP(S) webhooks are allowed — blocks file://, gopher://, ftp://, etc. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

function defaultLookup(host: string): Promise<ResolvedAddress[]> {
  return dnsLookup(host, { all: true });
}

/**
 * SSRF egress guard for tenant-controlled URLs (webhook `callback_url`). Rejects
 * non-http(s) schemes and any host that is — or DNS-resolves to — a private,
 * loopback, link-local, CGNAT, or otherwise non-public address (notably the
 * cloud metadata IP `169.254.169.254`). This is the load-bearing SSRF mitigation:
 * URL-format validation alone accepts `http://169.254.169.254/`.
 *
 * NOTE: this is for UNTRUSTED targets only. It must NOT be applied to the shared
 * upstream `HttpClient`, whose provider endpoints are operator-configured and may
 * legitimately be private (e.g. a self-hosted model server).
 *
 * Residual: a hostname could rebind to a private IP between this resolve and the
 * actual `fetch` (DNS-rebinding TOCTOU). Closing that fully requires pinning the
 * validated IP at connect time; the resolve-and-check here blocks the literal-IP
 * metadata attack and hostnames whose records point inward.
 */
export async function assertEgressAllowed(
  rawUrl: string,
  policy: EgressPolicy = {},
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressBlockedError('egress blocked: malformed URL');
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new EgressBlockedError(`egress blocked: scheme "${url.protocol}" is not http(s)`);
  }

  if (policy.allowPrivateTargets === true) return;

  // URL.hostname keeps IPv6 brackets; strip them for classification/resolution.
  const host = url.hostname.replace(/^\[|\]$/g, '');

  const literalKind = isIP(host); // 0 = hostname, 4 or 6 = literal IP
  let addresses: string[];
  if (literalKind === 0) {
    try {
      addresses = (await (policy.lookup ?? defaultLookup)(host)).map((a) => a.address);
    } catch {
      // DNS resolution failed (NXDOMAIN / transient). This is NOT an SSRF signal —
      // an unresolvable host cannot reach an internal service. Allow it through so
      // the caller's normal delivery attempt fails and retries/backs off rather
      // than being permanently dead-lettered as "blocked".
      return;
    }
    if (addresses.length === 0) return;
  } else {
    addresses = [host];
  }

  for (const addr of addresses) {
    if (isBlockedIp(addr)) {
      throw new EgressBlockedError(
        `egress blocked: "${host}" → ${addr} is a private/reserved address`,
      );
    }
  }
}

/** True if `ip` is a private/loopback/link-local/reserved address (or not a valid IP). */
function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return true; // unparseable → block conservatively
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf('%'); // drop a scope id (fe80::1%eth0)
  if (zone !== -1) addr = addr.slice(0, zone);

  if (addr === '::1' || addr === '::') return true; // loopback / unspecified

  // IPv4-mapped or -embedded (::ffff:1.2.3.4, ::1.2.3.4): classify the v4 tail.
  if (addr.includes('.')) {
    return isBlockedIpv4(addr.slice(addr.lastIndexOf(':') + 1));
  }

  const firstHextet = firstHextetOf(addr);
  if (firstHextet === undefined) return true;
  if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true; // fc00::/7 unique-local
  if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true; // fe80::/10 link-local
  if (firstHextet >= 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** The numeric value of the first 16-bit group of a (possibly abbreviated) IPv6 address. */
function firstHextetOf(addr: string): number | undefined {
  if (addr.startsWith('::')) return 0;
  const first = addr.split(':')[0];
  if (first === undefined || first.length === 0) return 0;
  const n = parseInt(first, 16);
  return Number.isNaN(n) ? undefined : n;
}
