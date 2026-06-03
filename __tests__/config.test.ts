import { beforeEach, describe, expect, it, vi } from "vitest";

const { getInputMock, githubContextMock, inputs } = vi.hoisted(() => ({
  getInputMock: vi.fn(),
  githubContextMock: {
    payload: {
      pull_request: {
        base: {
          ref: "main",
          sha: "a".repeat(40),
        },
        head: {
          sha: "b".repeat(40),
        },
        number: 42,
      },
    },
    repo: {
      owner: "Certora",
      repo: "zeus-guardian-ci",
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

  it("disables repo memory when use-memory is false", () => {
    inputs.set("use-memory", "false");

    expect(getConfig().useMemory).toBe(false);
  });

  it("defaults to the production Certora Zeus URL", () => {
    expect(getConfig().apiBaseUrl).toBe("https://zeus.certora.com");
  });
});
