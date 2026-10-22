import * as core from "@actions/core";
import {
  AutoProverApiError,
  getAutoProverApiErrorMessage,
} from "./api";
import { run } from "./run";
import { distrustCompromisedRoots } from "./tls";

// Before any request: the API key must never reach a forged certificate.
const distrusted = distrustCompromisedRoots();
if (distrusted.length > 0) {
  core.info(`Distrusted compromised root CAs: ${distrusted.join(", ")}`);
}

run().catch((error) => {
  if (error instanceof AutoProverApiError) {
    core.setFailed(getAutoProverApiErrorMessage(error));
  } else {
    core.setFailed(
      `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});
