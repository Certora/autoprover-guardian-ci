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
export declare const COMPROMISED_ROOT_FINGERPRINTS: ReadonlyMap<string, string>;
/**
 * Remove the compromised roots from Node's default CA store, which `fetch`
 * and every TLS client without its own `ca` option use. Returns the names of
 * the roots it removed: none on a runner Node older than 24.5 (no
 * `setDefaultCACertificates`), or once Node ships a store without them, which
 * is when this can go.
 */
export declare function distrustCompromisedRoots(): string[];
