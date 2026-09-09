import * as core from "@actions/core";
import {
  AutoProverApiError,
  getAutoProverApiErrorMessage,
} from "./api";
import { run } from "./run";

run().catch((error) => {
  if (error instanceof AutoProverApiError) {
    core.setFailed(getAutoProverApiErrorMessage(error));
  } else {
    core.setFailed(
      `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});
