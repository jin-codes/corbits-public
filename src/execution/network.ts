import { isIP } from "node:net";

const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/** Loopback, private, link-local (cloud metadata), CGNAT and unspecified addresses. */
export function isPrivateAddress(addr: string): boolean {
  const a = addr.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(a) === 4) return PRIVATE_V4.some((re) => re.test(a));
  if (isIP(a) === 6) {
    if (a === "::1" || a === "::") return true;
    if (a.startsWith("fe80:") || a.startsWith("fc") || a.startsWith("fd")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }
  return false;
}

export function isPrivateHostname(h: string): boolean {
  const host = h.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local");
}
