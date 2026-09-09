import { beforeEach, describe, expect, it, vi } from "vitest";

const { getInputMock, githubContextMock, inputs, setSecretMock } = vi.hoisted(
  () => ({
    getInputMock: vi.fn(),
    setSecretMock: vi.fn(),
    githubContextMock: {
      payload: {
        repository: { private: false },
        pull_request: {
          base: {
            sha: "a".repeat(40),
            repo: { full_name: "Certora/autoprover-guardian-ci" },
          },
          head: {
            sha: "b".repeat(40),
            repo: { full_name: "Certora/autoprover-guardian-ci" },
          },
          number: 42,
        },
      },
      repo: { owner: "Certora", repo: "autoprover-guardian-ci" },
      runId: 123,
      runAttempt: 2,
      job: "certora",
    },
    inputs: new Map<string, string>(),
  }),
);

vi.mock("@actions/core", () => ({
  getInput: getInputMock,
  setSecret: setSecretMock,
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("@actions/github", () => ({ context: githubContextMock }));

import { getConfig } from "../src/config";

describe("getConfig v2", () => {
  beforeEach(() => {
    inputs.clear();
    inputs.set("api-key", "certora_test");
    inputs.set("github-token", "ghs_test");
    inputs.set("context", "contracts/**/*.sol");
    githubContextMock.payload.repository.private = false;
    githubContextMock.payload.pull_request.head.repo.full_name =
      "Certora/autoprover-guardian-ci";
    githubContextMock.runAttempt = 2;
    getInputMock.mockImplementation(
      (name: string, options?: { required?: boolean }) => {
        const value = inputs.get(name) ?? "";
        if (options?.required && !value) throw new Error(`${name} is required`);
        return value;
      },
    );
  });

  it("defaults to the ai-auditor-diff workflow", () => {
    expect(getConfig()).toMatchObject({
      workflow: "ai-auditor-diff",
      apiBaseUrl: "https://app.certora.com",
      repositoryUrl: "https://github.com/Certora/autoprover-guardian-ci",
      repositoryPrivate: false,
      baseCommitSha: "a".repeat(40),
      headCommitSha: "b".repeat(40),
      githubRunAttempt: 2,
      idempotencySeed: expect.stringContaining("123:certora"),
      context: ["contracts/**/*.sol"],
      useMemory: true,
    });
    expect(setSecretMock).toHaveBeenCalledWith("certora_test");
    expect(setSecretMock).toHaveBeenCalledWith("ghs_test");
  });

  it.each(["ai-auditor-full", "ai-auditor-diff", "ai-auditor-finding-validation"])(
    "preserves mixed-language context for %s without requiring Solidity",
    (workflow) => {
      const context = ["src/**/*.py", "web/**/*.ts", "lib/**/*.rs", "server/**/*.go", "bin/worker", "Cargo.toml"];
      inputs.set("workflow", workflow);
      inputs.set("context", context.join(","));
      inputs.set("scope", "src/api.py");
      inputs.set("finding", "The Python route bypasses tenant authorization.");
      expect(getConfig()).toMatchObject({ workflow, context });
    },
  );

  it("keeps the idempotency seed stable across GitHub rerun attempts", () => {
    const firstAttemptSeed = getConfig().idempotencySeed;
    githubContextMock.runAttempt = 3;

    expect(getConfig()).toMatchObject({
      githubRunAttempt: 3,
      idempotencySeed: firstAttemptSeed,
    });
  });

  it("leaves an omitted model mode unset for legacy launch-body compatibility", () => {
    expect(getConfig()).toMatchObject({ maxIterations: 6 });
    expect(getConfig()).toHaveProperty("modelMode", undefined);
  });

  describe.each(["normal", "frontier"])("model-mode %s", (mode) => {
    it.each(["ai-auditor-full", "ai-auditor-diff"])(
      "keeps six iterations by default for %s",
      (workflow) => {
        inputs.set("workflow", workflow);
        inputs.set("model-mode", mode);
        expect(getConfig()).toMatchObject({ modelMode: mode, maxIterations: 6 });
      },
    );

    it.each([4, 10])("preserves an explicit %i iteration override", (iterations) => {
      inputs.set("model-mode", mode);
      inputs.set("max-iterations", String(iterations));
      expect(getConfig()).toMatchObject({ modelMode: mode, maxIterations: iterations });
    });

    it("supports finding validation without adding DeepDive iterations", () => {
      inputs.set("workflow", "ai-auditor-finding-validation");
      inputs.set("model-mode", mode);
      inputs.set("finding", "An authorization check is missing.");
      const config = getConfig();
      expect(config).toHaveProperty("modelMode", mode);
      expect(config).not.toHaveProperty("maxIterations");
    });

    it.each(["auto-prover", "auto-fuzzer"])("rejects the input for %s", (workflow) => {
      inputs.set("workflow", workflow);
      inputs.set("model-mode", mode);
      expect(() => getConfig()).toThrow("model-mode is only supported by AI Auditor workflows");
    });
  });

  it.each(["fast", "Frontier", "normal,frontier"])("rejects model-mode %j", (mode) => {
    inputs.set("model-mode", mode);
    expect(() => getConfig()).toThrow('model-mode must be "normal" or "frontier"');
  });

  it("accepts both explicit AI Auditor workflows and custom instructions", () => {
    inputs.set("workflow", "ai-auditor-full");
    inputs.set("instructions", "Focus on authorization.");
    inputs.set("scope", "contracts/src/**,contracts/lib/**");
    inputs.set("use-memory", "false");
    expect(getConfig()).toMatchObject({
      workflow: "ai-auditor-full",
      instructions: "Focus on authorization.",
      scope: ["contracts/src/**", "contracts/lib/**"],
      useMemory: false,
    });
  });

  it("records private repository access without forwarding a repository token", () => {
    githubContextMock.payload.repository.private = true;
    expect(getConfig()).toMatchObject({ repositoryPrivate: true });
  });

  it.each([
    "ai-auditor-full",
    "ai-auditor-diff",
    "ai-auditor-finding-validation",
  ])(
    "defaults to server-selected context for %s without expanding files locally",
    (workflow) => {
      inputs.set("workflow", workflow);
      inputs.delete("context");
      inputs.set("scope", "src/main.py");
      inputs.set("finding", "The route bypasses authorization.");
      expect(getConfig()).toMatchObject({ workflow, context: [] });
    },
  );

  it.each(["", "   ", ", ,,"])(
    "treats blank context input %j as automatic selection",
    (contextInput) => {
      inputs.set("workflow", "ai-auditor-diff");
      inputs.set("context", contextInput);
      expect(getConfig()).toMatchObject({ context: [] });
    },
  );

  it.each(["", "  ", ", ,"])("requires full auto audit scope for %j", (scope) => {
    inputs.set("workflow", "ai-auditor-full");
    inputs.delete("context");
    inputs.set("scope", scope);
    expect(() => getConfig()).toThrow("scope is required for full audits when context is selected automatically");
  });

  it("preserves explicit full context without requiring a separate scope", () => {
    inputs.set("workflow", "ai-auditor-full");
    expect(getConfig()).toMatchObject({ context: ["contracts/**/*.sol"], scope: undefined });
  });

  it("parses AutoProver contract and document inputs", () => {
    inputs.set("workflow", "auto-prover");
    inputs.delete("context");
    inputs.set("contract-path", "src/Vault.sol");
    inputs.set("contract-name", "Vault");
    inputs.set("design-doc-path", "docs/design.md");
    inputs.set("threat-model-path", "docs/threat.pdf");
    expect(getConfig()).toMatchObject({
      workflow: "auto-prover",
      contractPath: "src/Vault.sol",
      contractName: "Vault",
      designDocPath: "docs/design.md",
      threatModelPath: "docs/threat.pdf",
    });
  });

  it("parses the finding-validation workflow and required finding", () => {
    inputs.set("workflow", "ai-auditor-finding-validation");
    inputs.set("finding", "  Reentrancy in Vault.withdraw()  ");
    inputs.set("skip-submodules", "true");
    expect(getConfig()).toMatchObject({
      workflow: "ai-auditor-finding-validation",
      context: ["contracts/**/*.sol"],
      finding: "Reentrancy in Vault.withdraw()",
      skipSubmodules: true,
    });
  });

  it("requires a finding for finding validation", () => {
    inputs.set("workflow", "ai-auditor-finding-validation");
    expect(() => getConfig()).toThrow("finding is required");
  });

  it.each([
    ["context", `${"a".repeat(501)},contracts/**/*.sol`, "500 characters"],
    ["scope", "contracts/**/*.sol,src/\u0000Vault.sol", "null bytes"],
    ["instructions", "x".repeat(10_001), "10000 characters"],
  ])("mirrors the API limit for %s", (name, value, message) => {
    inputs.set("workflow", "ai-auditor-full");
    inputs.set(name, value);
    expect(() => getConfig()).toThrow(message);
  });

  it("rejects invalid workflows", () => {
    inputs.set("workflow", "finding-validation");
    expect(() => getConfig()).toThrow("workflow must be");
  });

  it.each(["../Vault.sol", "/src/Vault.sol", "src\\Vault.sol"])(
    "rejects unsafe contract path %s",
    (path) => {
      inputs.set("workflow", "auto-prover");
      inputs.set("contract-path", path);
      inputs.set("contract-name", "Vault");
      expect(() => getConfig()).toThrow("without traversal");
    },
  );

  it("rejects threat models for AutoFuzzer", () => {
    inputs.set("workflow", "auto-fuzzer");
    inputs.set("contract-path", "src/Vault.sol");
    inputs.set("contract-name", "Vault");
    inputs.set("threat-model-path", "docs/threat.md");
    expect(() => getConfig()).toThrow(
      "threat-model-path is only supported by auto-prover",
    );
  });

  it("rejects fork pull requests for generated-file workflows", () => {
    inputs.set("workflow", "auto-prover");
    inputs.set("contract-path", "src/Vault.sol");
    inputs.set("contract-name", "Vault");
    githubContextMock.payload.pull_request.head.repo.full_name = "fork/repo";
    expect(() => getConfig()).toThrow("same-repository pull request");
  });

  it.each([
    ["poll-interval", "1.5"],
    ["timeout", "0"],
    ["max-iterations", "11"],
  ])("rejects invalid %s", (name, value) => {
    inputs.set(name, value);
    expect(() => getConfig()).toThrow();
  });

  it("rejects ambiguous boolean inputs", () => {
    inputs.set("comment-on-pr", "yes");
    expect(() => getConfig()).toThrow(
      "comment-on-pr must be either true or false",
    );
  });

  it("rejects a misspelled fail-on severity instead of weakening policy", () => {
    inputs.set("fail-on", "HGIH");
    expect(() => getConfig()).toThrow(
      'fail-on contains unsupported severity "HGIH"',
    );
  });

  it("requires HTTPS except for loopback development", () => {
    inputs.set("api-base-url", "http://example.com");
    expect(() => getConfig()).toThrow("must use HTTPS");
    inputs.set("api-base-url", "http://127.0.0.1:3000/");
    expect(getConfig()).toMatchObject({
      apiBaseUrl: "http://127.0.0.1:3000",
    });
  });
});
