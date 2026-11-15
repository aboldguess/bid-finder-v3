// Guards against server-side request forgery. Administrators can point
// custom sources and webhooks at any URL, so before fetching we check the
// host does not resolve to this machine or a private network.
import dns from 'node:dns/promises';
import net from 'node:net';

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

export async function assertPublicUrl(url, { lookup = dns.lookup } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`Not a valid URL: ${url}`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https URLs are allowed');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new Error(`Could not resolve ${host}`);
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error(`${host} points at a private network address, which is not allowed`);
  return parsed;
}
