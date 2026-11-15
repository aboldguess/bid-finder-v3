// Completing a certificate chain the server left incomplete, as browsers do.
// Fixtures in test/fixtures/aia: a test root, an intermediate it signed, and a
// localhost certificate whose AIA field names the intermediate's address
// (made with openssl and test/fixtures/aia/ext.cnf).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import { agentForIncompleteChain, findMissingIssuer, resetAiaCache } from '../src/http/aia.js';

const fx = (f) => fs.readFileSync(new URL(`./fixtures/aia/${f}`, import.meta.url));
const root = fx('root.pem').toString();
const otherRoot = fx('other-root.pem').toString();
const leaf = new X509Certificate(fx('leaf.pem'));
const interDer = fx('inter.der');

test('finds the missing intermediate and checks it chains to a trusted root', async () => {
  const asked = [];
  const pem = await findMissingIssuer(leaf, { roots: [root], download: async (url) => { asked.push(url); return interDer; } });
  assert.deepEqual(asked, ['http://ca.example.test/intermediate.cer']);
  assert.match(pem, /BEGIN CERTIFICATE/);
  assert.equal(new X509Certificate(pem).subject, 'CN=Test Intermediate');
});

test('refuses an intermediate that is not signed by a trusted root', async () => {
  await assert.rejects(findMissingIssuer(leaf, { roots: [otherRoot], download: async () => interDer }), /does not chain to a trusted root/);
});

test('refuses a downloaded certificate that did not issue the server\'s', async () => {
  await assert.rejects(findMissingIssuer(leaf, { roots: [root], download: async () => fx('other-root.pem') }), /not the issuer/);
});

test('a server sending only its own certificate becomes reachable once the chain is completed', async (t) => {
  const server = https.createServer({ key: fx('leaf.key'), cert: fx('leaf.pem') }, (req, res) => res.end('hello'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); resetAiaCache(); });
  const { port } = server.address();
  // Even trusting the root, the chain cannot be built without the intermediate.
  await assert.rejects(undiciFetch(`https://localhost:${port}/`, { dispatcher: new (await import('undici')).Agent({ connect: { ca: [root] } }) }),
    (err) => err.cause?.code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' || err.cause?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  const agent = await agentForIncompleteChain('localhost', { port, roots: [root], download: async () => interDer });
  const res = await undiciFetch(`https://localhost:${port}/`, { dispatcher: agent });
  assert.equal(await res.text(), 'hello');
  await agent.close();
});
