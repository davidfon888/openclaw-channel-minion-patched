// IP allowlist with CIDR support (IPv4 only for now; extend if you have IPv6).

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const oct = Number.parseInt(part, 10);
    if (!Number.isInteger(oct) || oct < 0 || oct > 255) return null;
    n = (n << 8) | oct;
  }
  return n >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, prefixStr] = cidr.split("/");
  const prefix = prefixStr ? Number.parseInt(prefixStr, 10) : 32;
  if (!base || !Number.isFinite(prefix) || prefix < 0 || prefix > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  if (prefix === 0) return true;
  const mask = (-1 << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

export function isAllowed(ip: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true; // empty allowlist = allow all
  // Strip IPv6-mapped IPv4 prefix from headers like ::ffff:192.168.1.5
  const normalized = ip.replace(/^::ffff:/, "");
  return allowlist.some((entry) =>
    entry.includes("/") ? inCidr(normalized, entry) : entry === normalized,
  );
}
