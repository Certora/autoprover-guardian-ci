import { X509Certificate } from "node:crypto";
import * as tls from "node:tls";

/**
 * Root CAs over the eMudhra intermediates whose private keys were found
 * recoverable from the public certificates in October 2026 (Mozilla bug
 * 2083449, https://emudhra.we-have-a-problem.com/). Anyone can sign a
 * certificate for any host under them. Node checks no revocation and its
 * bundled store still trusts "emSign ECC Root CA - G3", so a runner on an
 * intercepted network would send the organization API key to a forged
 * Certora API certificate.
 *
 * SHA-256 fingerprints, from the incident's roots.json.
 */
export const COMPROMISED_ROOT_FINGERPRINTS: ReadonlyMap<string, string> =
  new Map([
    [
      "86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B",
      "emSign ECC Root CA - G3",
    ],
    [
      "7DD78D5F4F13459A83DFF9ABBBA62EDBAF6F2D102BF257FD712F4D9F2746ED8D",
      "emSign Root TLS CA - G3",
    ],
    [
      "F2EDAAFF3D9B701FB4D14C9F285F8C0BAD90FC3BCC1FA07D47F4718EDABA34A5",
      "emSign Root CS CA - G3",
    ],
    [
      "D7A7A0FB5D7E2731D771E9484EBCDEF71D5F0C3E0A2948782BC83EE0EA699EF4",
      "AAA Certificate Services",
    ],
  ]);

function fingerprintOf(pem: string): string {
  return new X509Certificate(pem).fingerprint256.replaceAll(":", "");
}

/**
 * Remove the compromised roots from Node's default CA store, which `fetch`
 * and every TLS client without its own `ca` option use. Returns the names of
 * the roots it removed: none on a runner Node older than 24.5 (no
 * `setDefaultCACertificates`), or once Node ships a store without them, which
 * is when this can go.
 */
export function distrustCompromisedRoots(): string[] {
  if (typeof tls.setDefaultCACertificates !== "function") return [];

  const roots = tls.getCACertificates("default");
  const removed: string[] = [];
  const kept = roots.filter((pem) => {
    const name = COMPROMISED_ROOT_FINGERPRINTS.get(fingerprintOf(pem));
    if (name !== undefined) removed.push(name);
    return name === undefined;
  });
  if (removed.length > 0) tls.setDefaultCACertificates(kept);
  return removed;
}
