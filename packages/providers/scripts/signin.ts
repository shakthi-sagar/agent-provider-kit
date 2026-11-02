// Runs a provider's sign-in flow (Antigravity: Google OAuth) and prints the URL to open.
// usage: node scripts/signin.ts antigravity
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createAgentKit, type AgentProvider } from "../src/kit/Agent.ts";

const provider = (process.argv[2] ?? "antigravity") as AgentProvider;
// T3's integrated terminal probes descendant HTTP listeners. Antigravity's OAuth
// listener handles one request, so a discovery GET consumes it before Google returns.
// A user service has no terminal ancestry and receives no agent thread attribution.
if (process.argv.includes("--isolated")) {
  if (process.platform !== "linux") {
    throw new Error("--isolated requires Linux with a systemd user session. Use an external terminal instead.");
  }
  const child = spawn("systemd-run", [
    "--user", "--quiet", "--pipe", "--wait", "--collect",
    `--working-directory=${process.cwd()}`,
    "--", "/usr/bin/env", "-u", "T3CODE_THREAD_ID",
    process.execPath, fileURLToPath(import.meta.url), provider,
  ], { stdio: "inherit" });
  child.on("error", (error) => {
    console.error(`Could not start isolated sign-in: ${error.message}`);
    process.exitCode = 1;
  });
  const code = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
  process.exit(code);
}

const kit = createAgentKit();
try {
  if (provider === "antigravity") await kit.install("antigravity");
  for await (const state of kit.signIn({ provider })) {
    console.log(`[${state.phase}] ${state.message ?? ""}`);
    if (state.phase === "waiting" && state.authorizationUrl) {
      console.log(`\nOpen this URL to sign in:\n${state.authorizationUrl}\n`);
      if (process.env.SIGNIN_DRY_RUN) break;
    }
  }
} finally {
  await kit.dispose();
}
