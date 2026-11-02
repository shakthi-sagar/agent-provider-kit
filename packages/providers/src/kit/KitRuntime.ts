// agent-provider-kit: the services T3's server.ts gives provider drivers, minus app-only ones
// (background power policy, telemetry, persistence, previews, managed Codex).
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerSettings } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ProviderCredentialError } from "@t3tools/provider-core/server/errors";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import type { DeepPartial } from "@t3tools/shared/Struct";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as EventNdjsonLogger from "../provider/EventNdjsonLogger.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderCredentialStore from "../provider/ProviderCredentialStore.ts";
import * as ResetCreditCoordinator from "../provider/resetCreditCoordinator.ts";
import * as ServerSettingsService from "../serverSettings.ts";

export interface KitRuntimeOptions {
  /** Where the kit keeps state, caches, attachments and secrets. */
  readonly baseDir: string;
  /** Default working directory for probes. */
  readonly cwd?: string;
  /** Overrides on T3's default server settings. */
  readonly settings?: DeepPartial<ServerSettings>;
  /** Write native and canonical provider events as NDJSON here (T3's providerEventLogPath). */
  readonly eventLogPath?: string;
}

// From T3's server.ts layerProviderEventLoggers; no-op unless a log path is given.
const layerEventLoggers = (eventLogPath: string | undefined) =>
  eventLogPath === undefined
    ? Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, ProviderEventLoggers.NoOpProviderEventLoggers)
    : Layer.effect(
        ProviderEventLoggers.ProviderEventLoggers,
        Effect.gen(function* () {
          const store = yield* EventNdjsonLogger.makeEventNdjsonLogStore(eventLogPath).pipe(
            Effect.catch((error) =>
              Effect.logWarning(error.message, { error }).pipe(Effect.as(undefined)),
            ),
          );
          if (!store) return ProviderEventLoggers.NoOpProviderEventLoggers;
          yield* Effect.addFinalizer(() => store.close());
          return { native: store.logger("native"), canonical: store.logger("canonical") };
        }),
      );

// Port of T3's provider/ProviderHostLive.ts with background work always allowed.
const layerProviderHost = Layer.effect(
  ProviderHost.ProviderHost,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettingsService.ServerSettingsService;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    return ProviderHost.ProviderHost.of({
      paths: {
        cwd: config.cwd,
        baseDir: config.baseDir,
        stateDir: config.stateDir,
        providerStatusCacheDir: config.providerStatusCacheDir,
        attachmentsDir: config.attachmentsDir,
      },
      settings: {
        get: serverSettings.getSettings,
        withSnapshot: serverSettings.withSettingsSnapshot,
        changes: serverSettings.streamChanges,
        subscribe: serverSettings.subscribeChanges,
      },
      shouldRunBackgroundWork: Effect.fn("ProviderHost.shouldRunBackgroundWork")(function* () {
        return true;
      }),
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
      resolveExtractedTextPath: Effect.fnUntraced(
        function* (path) {
          return yield* DocumentText.resolveExtractedTextPath(path);
        },
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      ),
      credentials: Effect.fn("ProviderHost.credentials")(function (namespace, bindingId) {
        return ProviderCredentialStore.make(namespace, bindingId).pipe(
          Effect.map((store) => ({
            binding: store.binding,
            get: store.get.pipe(
              Effect.mapError((cause) => new ProviderCredentialError({ operation: "get", cause })),
            ),
            set: (credentials: Uint8Array) =>
              store
                .set(credentials)
                .pipe(
                  Effect.mapError(
                    (cause) => new ProviderCredentialError({ operation: "set", cause }),
                  ),
                ),
            remove: store.remove.pipe(
              Effect.mapError(
                (cause) => new ProviderCredentialError({ operation: "remove", cause }),
              ),
            ),
          })),
          Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
          Effect.provideService(Crypto.Crypto, crypto),
        );
      }),
    });
  }),
);

/** Services shared by all kit provider drivers. */
export const layer = (options: KitRuntimeOptions) => {
  const base = Layer.mergeAll(
    ServerConfig.layerTest(options.cwd ?? process.cwd(), options.baseDir),
    ServerSettingsService.layerMemory(options.settings),
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)));
  const host = layerProviderHost.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(DocumentText.layer),
    Layer.provideMerge(base),
  );
  return Layer.mergeAll(
    AcpRegistrySupport.layerFromHost,
    OpenCodeRuntime.layer.pipe(
      Layer.provide(
        Layer.unwrap(Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return OpenCodeServerLedger.layer({ stateDir: config.stateDir });
        })),
      ),
    ),
    ModelManifest.layerModelCatalog,
    ResetCreditCoordinator.layer,
    ProviderLatestVersions.layer,
    McpProviderSessions.layer,
    CodexInstallation.CodexInstallation.layer,
    AntigravityInstallation.AntigravityInstallation.layer,
    // T3's ProviderOrchestrationAdapterInfrastructure, minus Cursor.
    ClaudeAdapterV2.layerQueryRunner,
    CodexAdapterV2.layerAppServerClientFactory,
    // ProviderContinuationRequests stays at its default (drop): nothing here drains the queue.
    IdAllocator.layer,
  ).pipe(
    Layer.provideMerge(ModelManifest.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        PortScanner.layerNoop,
        layerEventLoggers(options.eventLogPath),
      ),
    ),
    Layer.provideMerge(host),
  );
};

export type KitServices = Layer.Success<ReturnType<typeof layer>>;
