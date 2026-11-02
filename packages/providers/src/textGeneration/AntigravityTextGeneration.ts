// agent-provider-kit shim: see ./unsupported.ts.
import * as Effect from "effect/Effect";
import { unsupportedTextGeneration } from "./unsupported.ts";

export const makeAntigravityTextGeneration = (_options: {
  readonly makeRuntime: (cwd: string) => unknown;
  readonly [key: string]: unknown;
}) =>
  Effect.succeed(unsupportedTextGeneration);

export const isAntigravityTextGenerationAvailable = (_profileDirectory: string) =>
  Effect.succeed(false);
