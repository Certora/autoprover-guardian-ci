import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

function manifestKeys(manifest: string, section: "inputs" | "outputs") {
  const nextSection = section === "inputs" ? "outputs" : "runs";
  const body = manifest.match(
    new RegExp(`^${section}:\\n([\\s\\S]*?)(?=^${nextSection}:)`, "m"),
  )?.[1];
  if (!body) throw new Error(`Missing ${section} section in action.yml`);

  return [...body.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map(
    (match) => match[1],
  );
}

describe("published usage documentation", () => {
  it("uses the release channel that supports all documented engines", () => {
    const readme = read("README.md");
    const manifest = read("action.yml");
    const packageJson = JSON.parse(read("package.json")) as { name: string };

    expect(packageJson.name).toBe("autoprover-guardian-ci");
    expect(readme).toContain("# AutoProver Guardian CI");
    expect(manifest).toContain('name: "AutoProver Guardian CI"');
    expect(readme).toContain("Certora/autoprover-guardian-ci@main");
    expect(readme).not.toContain("Certora/zeus-guardian-ci@");
    expect(readme).toContain("AI Auditor");
    expect(readme).toContain("AutoProver");
    expect(readme).toContain("AutoFoundry");
  });

  it("matches generated workflow secrets and action defaults", () => {
    const readme = read("README.md");
    const manifest = read("action.yml");

    expect(readme).toContain("`AUTOPROVER_API_KEY` secret");
    expect(readme).not.toContain("AI_AUDITOR_API_KEY");
    expect(readme).not.toContain("ZEUS_API_KEY");
    expect(readme).toContain("`ai-auditor,security`");
    expect(manifest).toContain('default: "ai-auditor,security"');
    expect(readme).toContain("[AI Auditor] HIGH:");
    expect(readme).toContain("Legacy `[Auto Prover]` titles remain recognized");
  });

  it("documents launch retry and asynchronous cancellation semantics", () => {
    const readme = read("README.md");
    const manifest = read("action.yml");

    expect(readme).toMatch(
      /launch endpoints\s+do not\s+currently accept an idempotency key/,
    );
    expect(readme).toMatch(/a\s+confirmed `cancelled` run/);
    expect(readme).toContain("`cancellation_pending`");
    expect(manifest).toContain("cancellation_pending");
  });

  it("lists every action input and output in the README", () => {
    const readme = read("README.md");
    const manifest = read("action.yml");

    for (const input of manifestKeys(manifest, "inputs")) {
      expect(readme).toContain(`| \`${input}\``);
    }
    for (const output of manifestKeys(manifest, "outputs")) {
      expect(readme).toContain(`| \`${output}\``);
    }
  });

  it("scopes standalone documents and AI-only finding outputs accurately", () => {
    const readme = read("README.md");
    const manifest = read("action.yml");

    expect(readme).toContain(
      "repository-relative `.md`, `.markdown`, or `.pdf` files",
    );
    expect(manifest).toContain(
      "optional repository-relative .md, .markdown, or .pdf design document",
    );
    expect(manifest).toContain("AI Auditor HIGH severity finding count");
    expect(manifest).toContain("AI Auditor INFO severity finding count");
    expect(manifest).toContain(
      "AutoProver verification or AutoFoundry test outcome",
    );
    expect(readme).toMatch(
      /AutoFoundry comments instead show\s+generated test counts/,
    );
  });
});
