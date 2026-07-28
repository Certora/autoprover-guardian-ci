import { beforeEach, describe, expect, it, vi } from "vitest";

const { getInputMock, githubContextMock, inputs } = vi.hoisted(() => ({
  getInputMock: vi.fn(),
  githubContextMock: {
    payload: {
      pull_request: {
        base: {
          ref: "main",
          sha: "a".repeat(40),
          repo: {
            full_name: "Certora/autoprover-guardian-ci",
          },
        },
        head: {
          ref: "feature/vault",
          sha: "b".repeat(40),
          repo: {
            full_name: "Certora/autoprover-guardian-ci",
          },
        },
        number: 42,
      },
    },
    repo: {
      owner: "Certora",
      repo: "autoprover-guardian-ci",
    },
  },
  inputs: new Map<string, string>(),
}));

vi.mock("@actions/core", () => ({
  getInput: getInputMock,
  warning: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  context: githubContextMock,
}));

import { getConfig } from "../src/config";

function setRequiredInputs() {
  inputs.set("api-key", "zeus_live_test");
  inputs.set("context", "contracts/**/*.sol");
  inputs.set("github-token", "ghs_test");
}

describe("getConfig", () => {
  beforeEach(() => {
    inputs.clear();
    setRequiredInputs();
    githubContextMock.payload.pull_request.head.repo.full_name =
      "Certora/autoprover-guardian-ci";
    getInputMock.mockImplementation(
      (name: string, options?: { required?: boolean }) => {
        const value = inputs.get(name) ?? "";
        if (options?.required && !value) {
          throw new Error(`Input required and not supplied: ${name}`);
        }
        return value;
      },
    );
  });

  it("enables repo memory by default", () => {
    expect(getConfig().useMemory).toBe(true);
  });

  it("defaults to AI Auditor and requires context for that engine", () => {
    const config = getConfig();

    expect(config).toMatchObject({
      engine: "ai-auditor",
      auditType: "diff",
      context: ["contracts/**/*.sol"],
      labels: ["ai-auditor", "security"],
    });

    inputs.delete("context");
    expect(() => getConfig()).toThrow(
      "At least one context pattern is required.",
    );
  });

  it("disables repo memory when use-memory is false", () => {
    inputs.set("use-memory", "false");

    expect(getConfig().useMemory).toBe(false);
  });

  it("defaults to the production Certora Zeus URL", () => {
    expect(getConfig().apiBaseUrl).toBe("https://zeus.certora.com");
  });

  it.each([
    ["poll-interval", "1.5"],
    ["poll-interval", "60seconds"],
    ["timeout", "1.5"],
  ])("rejects a non-integer %s value of %s", (name, value) => {
    inputs.set(name, value);

    expect(() => getConfig()).toThrow(`${name} must be a positive integer.`);
  });

  it("rejects a partially numeric max-iterations value", () => {
    inputs.set("max-iterations", "6rounds");

    expect(() => getConfig()).toThrow(
      "max-iterations must be between 4 and 10.",
    );
  });

  it("parses AutoProver contract and document inputs without AI Auditor context", () => {
    inputs.set("engine", "auto-prover");
    inputs.delete("context");
    inputs.set("contract-path", "src/Vault.sol");
    inputs.set("contract-name", "Vault");
    inputs.set("design-doc-path", "docs/design.md");
    inputs.set("threat-model-path", "docs/threat-model.md");

    expect(getConfig()).toMatchObject({
      engine: "auto-prover",
      contractPath: "src/Vault.sol",
      contractName: "Vault",
      designDocPath: "docs/design.md",
      threatModelPath: "docs/threat-model.md",
      branchEnding: "b".repeat(40),
    });
  });

  it("parses AutoFoundry without AI Auditor-only inputs", () => {
    inputs.set("engine", "auto-foundry");
    inputs.delete("context");
    inputs.set("audit-type", "invalid-for-ai-auditor");
    inputs.set("max-iterations", "999");
    inputs.set("contract-path", "test/Vault.t.sol");
    inputs.set("contract-name", "VaultTest");

    expect(getConfig()).toMatchObject({
      engine: "auto-foundry",
      contractPath: "test/Vault.t.sol",
      contractName: "VaultTest",
    });
  });

  it.each([
    ["contract-path", "", "contract-path is required"],
    ["contract-name", "", "contract-name is required"],
  ])("requires %s for standalone engines", (name, value, message) => {
    inputs.set("engine", "auto-prover");
    inputs.set("contract-path", "src/Vault.sol");
    inputs.set("contract-name", "Vault");
    inputs.set(name, value);

    expect(() => getConfig()).toThrow(message);
  });

  it.each([
    "../src/Vault.sol",
    "/src/Vault.sol",
    "src\\Vault.sol",
    "src//Vault.sol",
    "src/.../Vault.sol",
  ])("rejects unsafe standalone contract path %s", (path) => {
    inputs.set("engine", "auto-prover");
    inputs.set("contract-path", path);
    inputs.set("contract-name", "Vault");

    expect(() => getConfig()).toThrow(
      "contract-path must be a repository-relative path without traversal.",
    );
  });

  it("requires a Solidity file and identifier", () => {
    inputs.set("engine", "auto-prover");
    inputs.set("contract-path", "src/Vault.vy");
    inputs.set("contract-name", "Vault");
    expect(() => getConfig()).toThrow(
      "contract-path must point to a .sol file.",
    );

    inputs.set("contract-path", "src/Vault.sol");
    inputs.set("contract-name", "Vault.sol");
    expect(() => getConfig()).toThrow(
      "contract-name must be a valid Solidity identifier.",
    );
  });

  it("enforces the API's standalone path and contract-name limits", () => {
    inputs.set("engine", "auto-prover");
    inputs.set("contract-path", `${"a".repeat(501)}.sol`);
    inputs.set("contract-name", "Vault");
    expect(() => getConfig()).toThrow(
      "contract-path must be at most 500 characters.",
    );

    inputs.set("contract-path", "src/Vault.sol");
    inputs.set("contract-name", "V".repeat(201));
    expect(() => getConfig()).toThrow(
      "contract-name must be at most 200 characters.",
    );
  });

  it("rejects control characters in standalone repository paths", () => {
    inputs.set("engine", "auto-prover");
    inputs.set("contract-path", "src/\nVault.sol");
    inputs.set("contract-name", "Vault");

    expect(() => getConfig()).toThrow(
      "contract-path must be a repository-relative path without traversal.",
    );
  });

  it.each(["docs/design.txt", "docs/design", "docs/design.sol"])(
    "rejects unsupported design document %s",
    (path) => {
      inputs.set("engine", "auto-prover");
      inputs.set("contract-path", "src/Vault.sol");
      inputs.set("contract-name", "Vault");
      inputs.set("design-doc-path", path);

      expect(() => getConfig()).toThrow(
        "design-doc-path must point to a .md, .markdown, or .pdf file.",
      );
    },
  );

  it("rejects a threat model for AutoFoundry", () => {
    inputs.set("engine", "auto-foundry");
    inputs.set("contract-path", "src/Vault.sol");
    inputs.set("contract-name", "Vault");
    inputs.set("threat-model-path", "docs/threat-model.md");

    expect(() => getConfig()).toThrow(
      "threat-model-path is only supported by auto-prover.",
    );
  });

  it("rejects fork pull requests before launching a standalone engine", () => {
    inputs.set("engine", "auto-prover");
    inputs.set("contract-path", "src/Vault.sol");
    inputs.set("contract-name", "Vault");
    githubContextMock.payload.pull_request.head.repo.full_name =
      "contributor/autoprover-guardian-ci";

    expect(() => getConfig()).toThrow(
      "AutoProver and AutoFoundry require a same-repository pull request",
    );
  });

  it("rejects unknown engines", () => {
    inputs.set("engine", "all-in-one");

    expect(() => getConfig()).toThrow(
      'engine must be "ai-auditor", "auto-prover", or "auto-foundry".',
    );
  });
});
