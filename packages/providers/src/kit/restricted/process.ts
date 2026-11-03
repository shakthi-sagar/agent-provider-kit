// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Scoped Promise transport with explicit teardown.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type Wire = Record<string, unknown>;
export const record = (value: unknown): Wire =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Wire) : {};
export const textBlocks = (value: unknown): string =>
  Array.isArray(value)
    ? value.map((v) => (record(v).type === "text" ? String(record(v).text ?? "") : "")).join("")
    : "";
export interface Launch {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}
export class OwnedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  private exit!: () => void;
  private stopped?: Promise<void>;
  private listeners = new Set<(line: string) => void>();
  private failures = new Set<(error: Error) => void>();
  private failure?: Error;
  constructor(input: Launch) {
    this.exited = new Promise((resolve) => {
      this.exit = resolve;
    });
    this.child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
    let pending = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.resume(); // Native stderr may contain credentials or full prompts; never return it.
    this.child.stdin.on("error", () => this.fail(new Error("Provider input stream closed.")));
    this.child.on("error", () => {
      this.fail(new Error(`Could not launch restricted provider: ${input.command}`));
      this.exit();
    });
    this.child.once("exit", (code) => {
      this.fail(new Error(`Restricted provider exited (${code ?? "signal"}).`));
      this.exit();
    });
    this.child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      if (pending.length > 16 * 1024 * 1024) {
        this.fail(new Error("Provider exceeded the protocol buffer limit."));
        void this.stop();
        return;
      }
      let at: number;
      while ((at = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, at).replace(/\r$/, "");
        pending = pending.slice(at + 1);
        if (line) for (const listener of this.listeners) listener(line);
      }
    });
  }
  onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onFailure(listener: (error: Error) => void): () => void {
    this.failures.add(listener);
    if (this.failure) listener(this.failure);
    return () => this.failures.delete(listener);
  }
  private fail(error: Error) {
    if (!this.failure) {
      this.failure = error;
      for (const listener of this.failures) listener(error);
    }
  }
  write(value: unknown) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  stop(): Promise<void> {
    return (this.stopped ??= (async () => {
      this.fail(new Error("Restricted provider process stopped."));
      const signal = (name: NodeJS.Signals) => {
        if (!this.child.pid) return;
        try {
          if (process.platform === "win32") this.child.kill(name);
          else process.kill(-this.child.pid, name);
        } catch {
          /* already gone */
        }
      };
      signal("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 750);
        }),
      ]);
      if (timer) clearTimeout(timer);
      signal("SIGKILL");
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      this.listeners.clear();
      this.failures.clear();
    })());
  }
}
export class JsonPeer {
  private serial = 0;
  private pending = new Map<
    string,
    { resolve: (value: Wire) => void; reject: (error: Error) => void }
  >();
  private listeners = new Set<(event: Wire) => void>();
  readonly process: OwnedProcess;
  readonly mode: "rpc" | "pi";
  constructor(process: OwnedProcess, mode: "rpc" | "pi") {
    this.process = process;
    this.mode = mode;
    process.onFailure((error) => {
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
    process.onLine((line) => {
      let event: Wire;
      try {
        event = record(JSON.parse(line));
      } catch {
        void process.stop();
        for (const request of this.pending.values())
          request.reject(new Error("Invalid provider protocol JSON."));
        this.pending.clear();
        return;
      }
      const pending = this.pending.get(String(event.id));
      if (
        pending &&
        (event.result !== undefined || event.error !== undefined || event.type === "response")
      ) {
        this.pending.delete(String(event.id));
        if (event.error !== undefined || event.success === false)
          pending.reject(
            new Error(`Restricted provider request failed: ${String(event.command ?? "RPC")}`),
          );
        else pending.resolve(this.mode === "pi" ? record(event.data) : record(event.result));
      } else if (event.id !== undefined && typeof event.method === "string") {
        // No filesystem, terminal, command, plugin or permission callback is executable here.
        if (event.method === "session/request_permission")
          process.write({
            jsonrpc: "2.0",
            id: event.id,
            result: { outcome: { outcome: "cancelled" } },
          });
        else
          process.write({
            jsonrpc: "2.0",
            id: event.id,
            error: { code: -32601, message: "Restricted client does not implement this operation" },
          });
      } else for (const listener of this.listeners) listener(event);
    });
  }
  onEvent(listener: (event: Wire) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  request(method: string, params: Wire = {}): Promise<Wire> {
    const id = String(++this.serial);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.process.write(
          this.mode === "pi"
            ? { ...params, id, type: method }
            : { jsonrpc: "2.0", id, method, params },
        );
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method: string, params: Wire = {}) {
    this.process.write(
      this.mode === "pi" ? { ...params, type: method } : { jsonrpc: "2.0", method, params },
    );
  }
}
