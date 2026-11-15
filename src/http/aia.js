// Some portals (Public Contracts Scotland among them) send their certificate
// without the intermediate that links it to a trusted root. Browsers fill the
// gap by downloading the intermediate from the address in the certificate's
// "Authority Information Access" field; Node does not. This does the same,
// and only accepts an intermediate that is signed by a root Node already
// trusts and that really issued the server's certificate.
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { Agent } from 'undici';
import { assertPublicUrl } from './ssrf.js';

export const INCOMPLETE_CHAIN = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT']);

// The certificate the server presents, read without trusting it.
export function peerCertificate(host, port = 443, connect = tls.connect) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 15000 }, () => {
      const cert = socket.getPeerX509Certificate();
      socket.end();
      cert ? resolve(cert) : reject(new Error(`${host} presented no certificate`));
    });
    socket.once('error', reject);
    socket.once('timeout', () => { socket.destroy(); reject(new Error(`Timed out reading the certificate of ${host}`)); });
  });
}

async function defaultDownload(url) {
  await assertPublicUrl(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > 64 * 1024) throw new Error(`Certificate at ${url} is too large`);
  return body;
}

// Returns the PEM of the missing intermediate, or throws saying why not.
export async function findMissingIssuer(leaf, { roots = tls.rootCertificates, download = defaultDownload, now = Date.now() } = {}) {
  const url = /CA Issuers - URI:(\S+)/.exec(leaf.infoAccess || '')?.[1];
  if (!url || !/^https?:\/\//.test(url)) throw new Error('certificate names no issuer to download');
  const issuer = new X509Certificate(await download(url));
  if (!leaf.checkIssued(issuer) || !leaf.verify(issuer.publicKey)) throw new Error(`${url} is not the issuer of the certificate`);
  if (Date.parse(issuer.validTo) < now || Date.parse(issuer.validFrom) > now) throw new Error('the issuing certificate has expired');
  const trusted = roots.map((pem) => new X509Certificate(pem)).some((root) => issuer.checkIssued(root) && issuer.verify(root.publicKey));
  if (!trusted) throw new Error('the issuing certificate does not chain to a trusted root');
  return issuer.toString();
}

const agents = new Map(); // host -> Agent that also trusts its intermediate

// An HTTP agent for `host` that trusts the intermediate the server left out.
export async function agentForIncompleteChain(host, { port = 443, roots = tls.rootCertificates, download, connect } = {}) {
  if (agents.has(host)) return agents.get(host);
  const leaf = await peerCertificate(host, port, connect);
  const pem = await findMissingIssuer(leaf, { roots, download });
  const agent = new Agent({ connect: { ca: [...roots, pem] } });
  agents.set(host, agent);
  return agent;
}

export const resetAiaCache = () => agents.clear();
