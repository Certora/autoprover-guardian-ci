import { AI_AUDITOR_CHECK_NAME, SHA_REGEX } from "./constants";
import type { ServerManagedGithubDelivery } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A persisted GitHub check, not merely an accepted audit or delivery request. */
export function isServerManagedGithubDelivery(
  value: unknown,
): value is ServerManagedGithubDelivery {
  if (!isRecord(value) || !isRecord(value.check)) return false;
  const check = value.check;
  if (
    value.type !== "github_pull_request" ||
    value.managed_by !== "server" ||
    !Number.isSafeInteger(value.pull_request_number) ||
    (value.pull_request_number as number) <= 0 ||
    !["pending", "in_progress", "completed"].includes(String(value.status)) ||
    !Number.isSafeInteger(check.id) ||
    (check.id as number) <= 0 ||
    // Older servers and persisted runs retain this exact legacy check name.
    (check.name !== AI_AUDITOR_CHECK_NAME &&
      check.name !== "AI Auditor" &&
      check.name !== "Zeus AI Audit") ||
    typeof check.head_sha !== "string" ||
    !SHA_REGEX.test(check.head_sha) ||
    !["in_progress", "completed"].includes(String(check.status)) ||
    typeof check.html_url !== "string" ||
    (value.error !== undefined &&
      value.error !== null &&
      typeof value.error !== "string")
  ) {
    return false;
  }
  try {
    const url = new URL(check.html_url);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
