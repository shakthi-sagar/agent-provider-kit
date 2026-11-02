// agent-provider-kit shim: managed Codex is not ported; the Codex adapter only needs this type.
import type { CodexSettings } from "@t3tools/contracts";

export interface CodexEffectiveRuntime {
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly revision: string;
}
