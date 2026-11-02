// @effect-diagnostics nodeBuiltinImport:off - the Promise facade builds ids and default paths outside Effect.
// agent-provider-kit: Promise/async-iterator facade over T3's provider drivers.
// It stands in for T3's orchestrator: one instance per provider, one app thread per session,
// one run per send().
import {
  ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type AcpRegistryListSessionsResult,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  OrchestrationV2ProviderThread,
  type ProviderApprovalDecision,
  type ProviderAuthState,
  type ProviderInstallState,
  type ProviderInteractionMode,
  type ProviderTurnId,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type RuntimeRequestId,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { PiDriver } from "@t3tools/provider-pi/server";
import { OpenCodeDriver } from "@t3tools/provider-opencode/server";
import { AcpRegistryDriver } from "@t3tools/provider-acp-registry/server";
import type { AnyProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs/promises";
import { attachmentRelativePath, createPendingAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import { AntigravityDriver } from "../provider/Drivers/AntigravityDriver.ts";
import { ClaudeDriver } from "../provider/Drivers/ClaudeDriver.ts";
import { CodexDriver } from "../provider/Drivers/CodexDriver.ts";
import * as KitRuntime from "./KitRuntime.ts";
import { createUsageTracker, loadRates, turnTotals, type UsageReport } from "./usage.ts";

export type AgentModel = ServerProviderModel;

export type AgentEvent = ProviderAdapter.ProviderAdapterV2Event;

const DRIVERS = {
  claude: ClaudeDriver,
  codex: CodexDriver,
  antigravity: AntigravityDriver,
  acp: AcpRegistryDriver,
  pi: PiDriver,
  opencode: OpenCodeDriver,
} satisfies Record<string, AnyProviderDriver<KitRuntime.KitServices>>;

export type AgentProvider = keyof typeof DRIVERS;

export interface InstanceOptions {
  readonly provider: AgentProvider;
  /**
   * Stable instance name; defaults to the provider name. State that a provider keeps per
   * instance (Antigravity's sign-in profile, thread continuity) is keyed by it.
   */
  readonly instance?: string;
  /** Driver settings (T3's ClaudeSettings, CodexSettings, ...); validated by the driver schema. */
  readonly config?: unknown;
  /** Extra environment for the agent process, e.g. ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN. */
  readonly env?: Readonly<Record<string, string>>;
}

export type AgentCapabilities = OrchestrationV2ProviderCapabilities;
export type AgentHistory = ProviderAdapter.ProviderAdapterV2ThreadSnapshot;
export type AgentRollbackOptions = Omit<
  ProviderAdapter.ProviderAdapterV2RollbackThreadInput,
  "providerThread"
>;
export type AgentForkOptions = Pick<
  ProviderAdapter.ProviderAdapterV2ForkThreadInput,
  "providerTurnId" | "sourceProviderTurns"
>;
export interface AgentSendOptions {
  readonly attachments?: readonly ChatAttachment[];
}
export interface AgentConfigureOptions {
  readonly model?: string;
  readonly options?: ModelSelection["options"];
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}
export type AgentAttachment = ChatAttachment;

export interface OpenAgentOptions extends InstanceOptions {
  /** Workspace the agent works in. */
  readonly cwd: string;
  /** Provider model slug, e.g. "claude-opus-4-7" or "gpt-5.5". */
  readonly model: string;
  readonly options?: ModelSelection["options"];
  /** Defaults to "full-access", T3's default. */
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  /** A thread from an earlier session's `providerThread`, to continue that conversation. */
  readonly resume?: OrchestrationV2ProviderThread | string;
}

export interface AgentSession {
  /** Persist this to resume the conversation with `open({ resume })`. */
  readonly providerThread: OrchestrationV2ProviderThread;
  /** JSON resume token; save after a turn, then pass to open({ resume }). Preserves timestamps and native session metadata. */
  serialize(): string;
  /** Runs one turn; yields every provider event until that turn's `turn.terminal`. */
  send(text: string, options?: AgentSendOptions): AsyncIterable<AgentEvent>;
  capabilities(): Promise<AgentCapabilities>;
  history(): Promise<AgentHistory>;
  fork(options?: AgentForkOptions): Promise<AgentSession>;
  rollback(options: AgentRollbackOptions): Promise<AgentHistory>;
  compact(instructions?: string): AsyncIterable<AgentEvent>;
  configure(options: AgentConfigureOptions): Promise<void>;
  steer(text: string, options?: AgentSendOptions): Promise<void>;
  hasPendingBackgroundWork(): Promise<boolean>;
  stopTask(taskId: string): Promise<void>;
  awaitBackgroundTasks(
    taskIds: readonly string[],
    awaited?: boolean,
  ): Promise<{ readonly matched: readonly string[] }>;
  stopSubagent(
    nativeTaskId: string,
  ): Promise<void | ProviderAdapter.ProviderAdapterV2SubagentOutcome>;
  /** Answers a `runtime_request.updated` event (approvals, user input). */
  respond(input: {
    readonly requestId: RuntimeRequestId;
    readonly decision?: ProviderApprovalDecision;
    readonly feedback?: string;
    readonly answers?: ProviderUserInputAnswers;
  }): Promise<void>;
  /** Interrupts the running turn, if any. */
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface AccountUsage {
  /** Signed-in account (email, plan label) as the provider reports it. */
  readonly account: ServerProviderAuth;
  /** Plan limit windows (session, weekly, ...) with used percent and reset time; undefined if the provider has none. */
  readonly limits: ServerProviderUsageLimits | undefined;
}

export interface AgentKit {
  open(options: OpenAgentOptions): Promise<AgentSession>;
  capabilities(options: InstanceOptions): Promise<AgentCapabilities>;
  /** Sessions currently open in this kit. Persist serialize() tokens in your application. */
  listSessions(): readonly AgentSession[];
  /** Provider-native inventory when the driver implements it (currently generic ACP). */
  listNativeSessions(
    options: InstanceOptions & { readonly cwd: string; readonly cursor?: string },
  ): Promise<AcpRegistryListSessionsResult>;
  /** Copies a file into kit-owned attachment storage. */
  attachment(
    path: string,
    options: { readonly mimeType: string; readonly type?: "image" | "file" },
  ): Promise<AgentAttachment>;
  /** Provider-discovered models. Refresh explicitly to reload the catalog. */
  models(
    options: InstanceOptions & { readonly refresh?: boolean; readonly cwd?: string },
  ): Promise<readonly AgentModel[]>;
  /** Plan limits for an instance. Uses the last probe unless `refresh` is set or none has run yet. */
  usageLimits(options: InstanceOptions & { readonly refresh?: boolean }): Promise<AccountUsage>;
  /** Token and estimated cost totals for every turn this kit has run, by instance and by model. */
  usage(): Promise<UsageReport>;
  /**
   * Runs the provider's own sign-in (Antigravity: Google OAuth). Yields auth states; open
   * `authorizationUrl` when the phase is "waiting". Ends on succeeded, failed or cancelled.
   */
  signIn(options: InstanceOptions): AsyncIterable<ProviderAuthState>;
  /** Downloads and verifies a managed runtime: Antigravity needs Google's agy-acp-server. */
  install(provider: "antigravity"): Promise<ProviderInstallState>;
  dispose(): Promise<void>;
}

type Item = { readonly event: AgentEvent } | { readonly failure: unknown };

const id = () => NodeCrypto.randomUUID();
const OWNER_SESSION_ID = "agent-provider-kit";
const threadResumeCodec = Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ProviderThread));

export function createAgentKit(options: Partial<KitRuntime.KitRuntimeOptions> = {}): AgentKit {
  const baseDir = options.baseDir ?? NodePath.join(NodeOS.homedir(), ".agent-provider-kit");
  const runtime = ManagedRuntime.make(KitRuntime.layer({ ...options, baseDir }));
  const run = <A, E>(effect: Effect.Effect<A, E, KitRuntime.KitServices>) =>
    runtime.runPromise(effect);
  // Instances outlive sessions, like T3's provider instance registry.
  const kitScope = Effect.runSync(Scope.make());
  const instances = new Map<
    string,
    { readonly key: string; readonly instance: Promise<ProviderInstance> }
  >();
  const sessions = new Set<AgentSession>();
  const discoveredModelCatalogs = new WeakSet<ProviderInstance>();
  const usage = createUsageTracker();

  const getInstance = (input: InstanceOptions) => {
    const name = input.instance ?? input.provider;
    if (!Schema.is(ProviderInstanceId)(name)) {
      return Promise.reject(
        new Error(
          `Instance name "${name}" must start with a letter and use only letters, digits, "-" or "_" (max 64).`,
        ),
      );
    }
    const key = JSON.stringify([input.provider, input.config ?? {}, input.env ?? {}]);
    const cached = instances.get(name);
    if (cached !== undefined) {
      if (cached.key !== key) {
        return Promise.reject(
          new Error(
            `Instance "${name}" is already open with other settings; pass another \`instance\`.`,
          ),
        );
      }
      return cached.instance;
    }
    const driver: AnyProviderDriver<KitRuntime.KitServices> = DRIVERS[input.provider];
    const instance = run(
      Effect.gen(function* () {
        // Trust boundary: caller-supplied settings go through the driver's own schema.
        const config = yield* Schema.decodeEffect(driver.configSchema)(input.config ?? {});
        return yield* driver.create({
          instanceId: ProviderInstanceId.make(name),
          displayName: undefined,
          environment: Object.entries(input.env ?? {}).map(([variable, value]) => ({
            name: variable,
            value,
            sensitive: true,
          })),
          enabled: true,
          config,
        });
      }).pipe(Effect.provideService(Scope.Scope, kitScope)),
    );
    instances.set(name, { key, instance });
    instance.catch(() => instances.delete(name));
    return instance;
  };

  const open = async (input: OpenAgentOptions): Promise<AgentSession> => {
    const resume =
      typeof input.resume === "string"
        ? Schema.decodeSync(threadResumeCodec)(input.resume)
        : input.resume;
    if (
      resume &&
      (resume.driver !== DRIVERS[input.provider].driverKind ||
        resume.providerInstanceId !== (input.instance ?? input.provider))
    ) {
      throw new Error("Resume must use the same provider and instance as the saved session.");
    }
    const instance = await getInstance(input);
    return run(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const inScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(Effect.provideService(Scope.Scope, scope));

        const instanceId = instance.instanceId;
        const threadId = resume?.appThreadId ?? ThreadId.make(`thread-${id()}`);
        let modelSelection: ModelSelection = {
          instanceId,
          model: input.model,
          ...(input.options ? { options: input.options } : {}),
        };
        const runtimeMode = input.runtimeMode ?? "full-access";
        const interactionMode = input.interactionMode ?? "default";
        let runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode,
          interactionMode,
          cwd: input.cwd,
        });

        const opened = yield* inScope(
          Effect.gen(function* () {
            const session = yield* instance.orchestrationAdapter.openSession({
              threadId,
              providerSessionId: ProviderSessionId.make(`session-${id()}`),
              ...(resume?.nativeThreadRef?.nativeId != null
                ? { initialNativeThreadId: resume.nativeThreadRef.nativeId }
                : {}),
              modelSelection,
              runtimePolicy,
            });
            const providerThread = yield* resume
              ? session.resumeThread({
                  providerThread: resume,
                  threadId,
                  modelSelection,
                  runtimePolicy,
                })
              : session.ensureThread({ threadId, modelSelection, runtimePolicy });
            return { session, providerThread };
          }),
        ).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
        const { session } = opened;

        const queue = yield* Queue.unbounded<Item>();
        const state = {
          providerThread: opened.providerThread,
          capabilities: session.providerSession.capabilities,
          turnId: undefined as ProviderTurnId | undefined,
          runOrdinal: resume?.lastRunOrdinal ?? 0,
          activeRunId: undefined as RunId | undefined,
          nativeTurnActive: false,
          active: false,
          operation: false,
          closed: false,
        };
        // Single consumer of the adapter stream; tracks the thread and turn the facade needs.
        yield* inScope(
          session.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event.type === "provider_thread.updated") {
                  if (event.providerThread.id === state.providerThread.id) {
                    state.providerThread = event.providerThread;
                  }
                } else if (event.type === "provider_session.updated") {
                  state.capabilities = event.providerSession.capabilities;
                } else if (event.type === "provider_turn.updated") {
                  if (event.providerTurn.providerThreadId === state.providerThread.id) {
                    state.turnId = event.providerTurn.id;
                    state.nativeTurnActive =
                      event.providerTurn.status === "running" ||
                      event.providerTurn.status === "pending";
                  }
                  const turnUsage = event.providerTurn.turnTokenUsage;
                  if (turnUsage !== undefined) {
                    usage.record(event.providerTurn.id, {
                      instance: instanceId,
                      model: modelSelection.model,
                      totals: turnTotals(turnUsage),
                    });
                  }
                }
              }).pipe(Effect.andThen(Queue.offer(queue, { event }))),
            ),
            Effect.catchCause((cause) => Queue.offer(queue, { failure: cause })),
            Effect.forkScoped,
          ),
        );

        const now = yield* DateTime.now;
        const appThread: OrchestrationV2AppThread = {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make(`project-${id()}`),
          title: "agent-provider-kit session",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode,
          interactionMode,
          branch: null,
          worktreePath: input.cwd,
          activeProviderThreadId: state.providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };

        const requireOpen = () => {
          if (state.closed) throw new Error("Session is closed.");
        };
        const requireIdle = () => {
          requireOpen();
          if (state.active || state.operation)
            throw new Error(
              "A turn or session operation is active; wait for it or interrupt the turn first.",
            );
        };
        const exclusively = async <A>(task: () => Promise<A>): Promise<A> => {
          requireIdle();
          state.operation = true;
          try {
            return await task();
          } finally {
            state.operation = false;
          }
        };
        const unsupported = (operation: string): never => {
          throw new Error(`${input.provider} does not support ${operation}.`);
        };
        const getCapabilities = async () => {
          requireOpen();
          return state.capabilities;
        };
        const message = (text: string, options?: AgentSendOptions) =>
          ProviderAdapter.ProviderAdapterV2TurnMessage.make({
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make(`message-${id()}`),
            text,
            attachments: [...(options?.attachments ?? [])],
          });
        const sendTurn = async function* (
          text: string,
          options?: AgentSendOptions,
          compact = false,
        ): AsyncIterable<AgentEvent> {
          requireIdle();
          if (compact && !session.compactThread) unsupported("compaction");
          state.active = true;
          state.turnId = undefined;
          state.nativeTurnActive = false;
          const runOrdinal = ++state.runOrdinal;
          state.activeRunId = RunId.make(`run-${id()}`);
          let terminal = false;
          try {
            await run(
              (compact ? session.compactThread! : session.startTurn)({
                appThread: {
                  ...appThread,
                  modelSelection,
                  runtimeMode: runtimePolicy.runtimeMode,
                  interactionMode: runtimePolicy.interactionMode,
                },
                threadId,
                runId: state.activeRunId,
                runOrdinal,
                providerTurnOrdinal: runOrdinal,
                nativeThreadHasTurns: runOrdinal > 1 || resume !== undefined,
                attemptId: RunAttemptId.make(`attempt-${id()}`),
                rootNodeId: NodeId.make(`node-${id()}`),
                providerThread: state.providerThread,
                message: message(text, options),
                modelSelection,
                runtimePolicy,
              }).pipe(
                Effect.catchCause((cause) => Queue.offer(queue, { failure: cause })),
                Effect.forkIn(scope),
              ),
            );
            while (true) {
              const item = await run(Queue.take(queue));
              if ("failure" in item) throw new Error("Agent turn failed", { cause: item.failure });
              terminal =
                item.event.type === "turn.terminal" &&
                item.event.runOrdinal === runOrdinal &&
                item.event.providerThreadId === state.providerThread.id;
              yield item.event;
              if (terminal) return;
            }
          } finally {
            try {
              if (!terminal && !state.closed && state.turnId)
                await run(
                  session.interruptTurn({
                    providerThread: state.providerThread,
                    providerTurnId: state.turnId,
                  }),
                );
            } finally {
              state.active = false;
              state.activeRunId = undefined;
            }
          }
        };
        const agent: AgentSession = {
          get providerThread() {
            return state.providerThread;
          },
          serialize: () => Schema.encodeSync(threadResumeCodec)(state.providerThread),
          send: (text, options) => sendTurn(text, options),
          compact: (instructions = "") => sendTurn(instructions, undefined, true),
          capabilities: getCapabilities,
          history: () =>
            exclusively(async () => {
              if (!(await getCapabilities()).threads.canReadThreadSnapshot)
                unsupported("history snapshots");
              return run(session.readThreadSnapshot({ providerThread: state.providerThread }));
            }),
          fork: (options = {}) =>
            exclusively(async () => {
              const capabilities = await getCapabilities();
              if (
                !capabilities.threads.canForkThread ||
                (options.providerTurnId && !capabilities.threads.canForkFromTurn)
              )
                unsupported("forking at this point");
              const forked = await run(
                session.forkThread({
                  sourceProviderThread: state.providerThread,
                  targetThreadId: ThreadId.make(`thread-${id()}`),
                  modelSelection,
                  runtimePolicy,
                  ...options,
                }),
              );
              return open({
                ...input,
                model: modelSelection.model,
                ...(modelSelection.options ? { options: modelSelection.options } : {}),
                runtimeMode: runtimePolicy.runtimeMode,
                interactionMode: runtimePolicy.interactionMode,
                resume: forked,
              });
            }),
          rollback: (options) =>
            exclusively(async () => {
              if (!(await getCapabilities()).threads.canRollbackThread) unsupported("rollback");
              const snapshot = await run(
                session.rollbackThread({ ...options, providerThread: state.providerThread }),
              );
              state.providerThread = snapshot.providerThread;
              return snapshot;
            }),
          configure: (options) =>
            exclusively(async () => {
              const capabilities = await getCapabilities();
              const target: ModelSelection = {
                ...modelSelection,
                ...(options.model ? { model: options.model } : {}),
                ...(options.options !== undefined ? { options: options.options } : {}),
              };
              const plan = await run(
                instance.orchestrationAdapter.planSelectionTransition({
                  current: modelSelection,
                  target,
                  sessionCapabilities: capabilities,
                }),
              );
              if (plan.type !== "apply_on_next_turn")
                throw new Error(
                  plan.type === "reject"
                    ? plan.reason
                    : `Selection change requires ${plan.type}; reopen using serialize() with the desired settings.`,
                );
              if (
                options.runtimeMode !== undefined &&
                options.runtimeMode !== runtimePolicy.runtimeMode &&
                !capabilities.sessions.supportsRuntimeModeSwitchInSession
              )
                unsupported("runtime mode switching");
              const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                ...runtimePolicy,
                ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
                ...(options.interactionMode ? { interactionMode: options.interactionMode } : {}),
              });
              const thread = await run(
                session.resumeThread({
                  providerThread: state.providerThread,
                  threadId,
                  modelSelection: target,
                  runtimePolicy: policy,
                }),
              );
              state.providerThread = thread;
              modelSelection = target;
              runtimePolicy = policy;
            }),
          steer: async (text, options) => {
            requireOpen();
            if (!state.active || !state.nativeTurnActive || !state.activeRunId || !state.turnId)
              throw new Error("No active provider turn to steer.");
            const runId = state.activeRunId,
              providerTurnId = state.turnId;
            if (!(await getCapabilities()).turns.supportsActiveSteering)
              unsupported("active-turn steering");
            if (state.activeRunId !== runId || !state.nativeTurnActive)
              throw new Error("The provider turn has already finished.");
            await run(
              session.steerTurn({
                threadId,
                runId,
                providerThread: state.providerThread,
                providerTurnId,
                message: message(text, options),
              }),
            );
          },
          hasPendingBackgroundWork: async () => {
            requireOpen();
            return run(
              session.hasPendingBackgroundWorkForThread
                ? session.hasPendingBackgroundWorkForThread(state.providerThread)
                : (session.hasPendingBackgroundWork ?? Effect.succeed(false)),
            );
          },
          stopTask: async (taskId) => {
            requireOpen();
            if (!session.stopTask) unsupported("stopping tasks");
            await run(session.stopTask!({ providerThread: state.providerThread, taskId }));
          },
          awaitBackgroundTasks: async (taskIds, awaited = true) => {
            requireOpen();
            if (!session.awaitBackgroundTasks) unsupported("waiting for background tasks");
            return run(
              session.awaitBackgroundTasks!({
                providerThread: state.providerThread,
                taskIds,
                awaited,
              }),
            );
          },
          stopSubagent: async (nativeTaskId) => {
            requireOpen();
            if (!session.stopSubagent) unsupported("stopping subagents");
            return run(
              session.stopSubagent!({ providerThread: state.providerThread, nativeTaskId }),
            );
          },
          respond: (request) => {
            requireOpen();
            return run(session.respondToRuntimeRequest(request));
          },
          interrupt: async () => {
            requireOpen();
            if (!state.active || !state.nativeTurnActive || state.turnId === undefined) return;
            await run(
              session.interruptTurn({
                providerThread: state.providerThread,
                providerTurnId: state.turnId,
              }),
            );
          },
          close: async () => {
            if (state.closed) return;
            state.closed = true;
            await run(Queue.offer(queue, { failure: new Error("Session closed") }));
            sessions.delete(agent);
            await run(Scope.close(scope, Exit.void));
          },
        };
        sessions.add(agent);
        return agent;
      }),
    );
  };

  async function* signIn(input: InstanceOptions): AsyncIterable<ProviderAuthState> {
    const instance = await getInstance(input);
    const auth = instance.auth;
    if (auth === undefined) throw new Error(`${input.provider} has no sign-in flow in the kit.`);
    const states = await run(Queue.unbounded<ProviderAuthState>());
    // Subscribe before starting so no state published by start() is missed.
    const subscription = await run(
      auth.subscribe(OWNER_SESSION_ID).pipe(
        Stream.runForEach((state) => Queue.offer(states, state)),
        Effect.forkIn(kitScope),
      ),
    );
    try {
      let state = await run(auth.start(OWNER_SESSION_ID));
      while (true) {
        yield state;
        if (
          state.phase === "succeeded" ||
          state.phase === "failed" ||
          state.phase === "cancelled"
        ) {
          return;
        }
        state = await run(Queue.take(states));
      }
    } finally {
      await run(Fiber.interrupt(subscription));
    }
  }

  const install = async () => {
    const final = await run(
      Effect.gen(function* () {
        const installation = yield* AntigravityInstallation.AntigravityInstallation;
        const done = (state: ProviderInstallState) =>
          state.phase === "succeeded" || state.phase === "failed" || state.phase === "cancelled";
        const started = yield* installation.start;
        if (done(started)) return started;
        const finished = yield* installation.changes.pipe(Stream.filter(done), Stream.runHead);
        return Option.getOrElse(finished, () => started);
      }),
    );
    if (final.phase !== "succeeded") {
      throw new Error(`Antigravity install ${final.phase}: ${final.message ?? "no details"}`);
    }
    return final;
  };

  const usageLimits = async ({
    refresh = false,
    ...input
  }: InstanceOptions & { readonly refresh?: boolean }): Promise<AccountUsage> => {
    const { snapshot } = await getInstance(input);
    const provider = await run(
      Effect.gen(function* () {
        const current = yield* snapshot.getSnapshot;
        return refresh || current.usageLimits === undefined ? yield* snapshot.refresh : current;
      }),
    );
    return { account: provider.auth, limits: provider.usageLimits };
  };

  return {
    open,
    capabilities: async (input) =>
      run((await getInstance(input)).orchestrationAdapter.getCapabilities()),
    listSessions: () => [...sessions],
    listNativeSessions: async ({ cwd, cursor, ...input }) => {
      const instance = await getInstance(input);
      if (!instance.acpSessionManagement)
        throw new Error(
          `${input.provider} does not expose native session listing through its driver.`,
        );
      return run(
        instance.acpSessionManagement.listSessions({ cwd, ...(cursor ? { cursor } : {}) }),
      );
    },
    attachment: async (filePath, options) => {
      const stat = await NodeFS.stat(filePath);
      if (!stat.isFile()) throw new Error("Attachment must be a file.");
      const attachment = Schema.decodeSync(ChatAttachment)({
        type: options.type ?? (options.mimeType.startsWith("image/") ? "image" : "file"),
        id: createPendingAttachmentId(),
        name: NodePath.basename(filePath),
        mimeType: options.mimeType,
        sizeBytes: stat.size,
      });
      const relative = attachmentRelativePath(attachment);
      if (!relative) throw new Error("Unsupported attachment type.");
      const directory = await run(
        Effect.map(ServerConfig.ServerConfig, (config) => config.attachmentsDir),
      );
      await NodeFS.mkdir(directory, { recursive: true, mode: 0o700 });
      await NodeFS.copyFile(filePath, NodePath.join(directory, relative));
      return attachment;
    },
    usageLimits,
    models: async ({ refresh = false, cwd, ...input }) => {
      const instance = await getInstance(input);
      return run(
        Effect.gen(function* () {
          let snapshot = yield* instance.snapshot.getSnapshot;
          if (refresh || !discoveredModelCatalogs.has(instance) || snapshot.models.length === 0) {
            if (instance.refreshModels) {
              yield* instance.refreshModels();
              snapshot = yield* instance.snapshot.getSnapshot;
            } else {
              snapshot = yield* instance.snapshot.refresh;
            }
          }
          if (cwd && instance.snapshotForCwd) {
            snapshot = yield* instance.snapshotForCwd(cwd);
          }
          discoveredModelCatalogs.add(instance);
          return snapshot.models;
        }),
      );
    },
    usage: async () => {
      const { rates, pricing } = await loadRates(baseDir);
      return usage.report(rates, pricing);
    },
    signIn,
    install,
    dispose: async () => {
      await Promise.all([...sessions].map((session) => session.close()));
      await run(Scope.close(kitScope, Exit.void));
      await runtime.dispose();
    },
  };
}
