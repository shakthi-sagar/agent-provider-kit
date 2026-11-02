// agent-provider-kit: T3's git/PR/title text generation is not ported; every operation fails cleanly.
import { TextGenerationError } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";

const fail = (operation: string) => () =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Text generation is not supported by agent-provider-kit.",
    }),
  );

export const unsupportedTextGeneration: ProviderTextGeneration = {
  generateCommitMessage: fail("generateCommitMessage"),
  generatePrContent: fail("generatePrContent"),
  generateBranchName: fail("generateBranchName"),
  generateThreadTitle: fail("generateThreadTitle"),
  generateReviewGuide: fail("generateReviewGuide"),
};
