import * as core from "@actions/core";
import { getZeusApiErrorMessage, ZeusApiError } from "./api";
import { run } from "./run";

run().catch((error) => {
  if (error instanceof ZeusApiError) {
    core.setFailed(getZeusApiErrorMessage(error));
  } else {
    core.setFailed(
      `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});
