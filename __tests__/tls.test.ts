import { X509Certificate } from "node:crypto";
import * as tls from "node:tls";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  COMPROMISED_ROOT_FINGERPRINTS,
  distrustCompromisedRoots,
} from "../src/tls";

// eMudhra incident (October 2026): the action drops the roots over the
// compromised intermediates from Node's default CA store before it sends the
// API key anywhere.

// emSign ECC Root CA - G3, as Node's bundled store shipped it.
const EMSIGN_ECC_ROOT_G3 = `-----BEGIN CERTIFICATE-----
MIICTjCCAdOgAwIBAgIKPPYHqWhwDtqLhDAKBggqhkjOPQQDAzBrMQswCQYDVQQGEwJJTjET
MBEGA1UECxMKZW1TaWduIFBLSTElMCMGA1UEChMcZU11ZGhyYSBUZWNobm9sb2dpZXMgTGlt
aXRlZDEgMB4GA1UEAxMXZW1TaWduIEVDQyBSb290IENBIC0gRzMwHhcNMTgwMjE4MTgzMDAw
WhcNNDMwMjE4MTgzMDAwWjBrMQswCQYDVQQGEwJJTjETMBEGA1UECxMKZW1TaWduIFBLSTEl
MCMGA1UEChMcZU11ZGhyYSBUZWNobm9sb2dpZXMgTGltaXRlZDEgMB4GA1UEAxMXZW1TaWdu
IEVDQyBSb290IENBIC0gRzMwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAQjpQy4LRL1KPOxst3i
AhKAnjlfSU2fySU0WXTsuwYc58Byr+iuL+FBVIcUqEqy6HyC5ltqtdyzdc6LBtCGI79G1Y4P
PwT01xySfvalY8L1X44uT6EYGQIrMgqCZH0Wk9GjQjBAMB0GA1UdDgQWBBR8XQKEE9TMipuB
zhccLikenEhjQjAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQD
AwNpADBmAjEAvvNhzwIQHWSVB7gYboiFBS+DCBeQyh+KTOgNG3qxrdWBCUfvO6wIBHxcmbHt
RwfSAjEAnbpV/KlK6O3t5nYBQnvI+GDZjVGLVTv7jHvrZQnD+JbNR6iC8hZVdyR+EhCVBCyj
-----END CERTIFICATE-----
`;

const fingerprintOf = (pem: string) =>
  new X509Certificate(pem).fingerprint256.replaceAll(":", "");

let defaultRoots: string[];

beforeAll(() => {
  defaultRoots = tls.getCACertificates("default");
});

afterEach(() => {
  tls.setDefaultCACertificates(defaultRoots);
});

describe("distrustCompromisedRoots", () => {
  it("removes a compromised root and keeps every other root", () => {
    const otherRoot = tls
      .getCACertificates("bundled")
      .find((pem) => !COMPROMISED_ROOT_FINGERPRINTS.has(fingerprintOf(pem)));
    if (otherRoot === undefined) throw new Error("no bundled root to keep");
    tls.setDefaultCACertificates([EMSIGN_ECC_ROOT_G3, otherRoot]);

    expect(distrustCompromisedRoots()).toEqual(["emSign ECC Root CA - G3"]);

    expect(tls.getCACertificates("default").map(fingerprintOf)).toEqual([
      fingerprintOf(otherRoot),
    ]);
  });

  it("leaves no compromised root in Node's default store", () => {
    distrustCompromisedRoots();

    const fingerprints = tls.getCACertificates("default").map(fingerprintOf);
    expect(
      fingerprints.filter((fingerprint) =>
        COMPROMISED_ROOT_FINGERPRINTS.has(fingerprint),
      ),
    ).toEqual([]);
    expect(fingerprints.length).toBeGreaterThan(100);
  });

  it("changes nothing once the store holds no compromised root", () => {
    distrustCompromisedRoots();
    const after = tls.getCACertificates("default");

    expect(distrustCompromisedRoots()).toEqual([]);
    expect(tls.getCACertificates("default")).toEqual(after);
  });
});
