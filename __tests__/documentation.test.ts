import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync("README.md", "utf8");
const action = readFileSync("action.yml", "utf8");

describe("published v2 documentation", () => {
  it("distinguishes language-independent AI Auditor from Solidity-only engines", () => {
    const normalizedReadme = readme.replace(/\s+/g, " ");
    expect(normalizedReadme).toContain("AI Auditor supports any programming language");
    expect(normalizedReadme).toContain("Only AutoProver and AutoFuzzer require Solidity contracts");
  });

  it("documents the five supported workflows and v2 release", () => {
    for (const workflow of [
      "ai-auditor-full",
      "ai-auditor-diff",
      "ai-auditor-finding-validation",
      "auto-prover",
      "auto-fuzzer",
    ]) {
      expect(readme).toContain(`\`${workflow}\``);
      expect(action).toContain(workflow);
    }
    expect(readme).toContain("Certora/autoprover-guardian-ci@v2");
    expect(readme).toContain("`finding`");
    expect(readme).toContain("`validation-verdict`");
  });

  it("documents Bearer v2 behavior and no progress endpoint", () => {
    const normalizedReadme = readme.replace(/\s+/g, " ");
    expect(readme).toContain("public `/v2` run API");
    expect(normalizedReadme).toContain(
      "There is no separate progress endpoint",
    );
    expect(readme).toContain("`Idempotency-Key`");
    expect(readme).toContain("`Estimate-Quote-Id`");
    expect(readme).toContain("polls `GET /v2/runs/{run_id}`");
    expect(readme).toContain("`source_revision_not_found`");
    expect(readme).toContain("`contract_not_found`");
    expect(readme).not.toContain("/api/v1");
    expect(readme).not.toContain("X-API-Key");
    expect(readme).toContain("https://app.certora.com");
    expect(action).toContain('default: "https://app.certora.com"');
    expect(action).toContain('using: "node24"');
  });

  it("documents Guardian's explicit AI Auditor context policy", () => {
    const normalizedReadme = readme.replace(/\s+/g, " ");
    expect(normalizedReadme).toContain(
      "Guardian CI intentionally requires an explicit `context` input for every AI Auditor workflow",
    );
    expect(normalizedReadme).toContain("matching the public REST API");
    expect(normalizedReadme).toContain(
      "loads direct submodules only, never nested submodules",
    );
    expect(normalizedReadme).not.toContain(
      "public REST API supports automatic context selection",
    );
    expect(normalizedReadme).toContain(
      "GitHub action metadata cannot make an input conditionally required",
    );
    expect(action).toContain(
      "Required for every AI Auditor workflow: explicit comma-separated glob patterns",
    );
    const contextInput = action.split("  context:")[1]?.split("\n\n")[0] ?? "";
    expect(contextInput).toContain("required: false");
  });

  it("states that GitHub credentials stay local", () => {
    expect(readme).toContain("It is never sent to Certora");
    expect(action).toContain("It is never sent to Certora");
    expect(readme).toContain("organization_github_app");
  });

  it("documents run terminology, commit binding, and the exact trailer", () => {
    expect(readme).toContain("`run-id`");
    expect(action).toContain("run-id:");
    expect(readme).toContain("Certora-Guardian-Run: <UUID>");
    expect(readme).toContain("Zeus-Guardian-Job: <UUID>");
    expect(readme).toContain("empty-body");
  });

  it("lists every action input and output", () => {
    const inputsBlock = action.split("inputs:")[1]?.split("outputs:")[0] ?? "";
    const outputsBlock = action.split("outputs:")[1]?.split("runs:")[0] ?? "";
    const keys = (block: string) =>
      [...block.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]);
    for (const input of keys(inputsBlock))
      expect(readme).toContain(`\`${input}\``);
    for (const output of keys(outputsBlock))
      expect(readme).toContain(`\`${output}\``);
  });
});
