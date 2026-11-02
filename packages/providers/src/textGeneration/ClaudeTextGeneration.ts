// agent-provider-kit shim: see ./unsupported.ts.
import * as Effect from "effect/Effect";
import { unsupportedTextGeneration } from "./unsupported.ts";

export const makeClaudeTextGeneration = (..._args: ReadonlyArray<unknown>) =>
  Effect.succeed(unsupportedTextGeneration);
