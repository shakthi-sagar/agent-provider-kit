// @effect-diagnostics nodeBuiltinImport:off - Private native profiles contain credentials, never inherited executable configuration.
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as OS from "node:os";
import type { OpenRestrictedOptions } from "../Restricted.ts";
export interface RestrictedContext {
  readonly directory: string;
  readonly antigravity?: () => Promise<{
    command: string;
    args: readonly string[];
    credentialDirectory: string;
    env: NodeJS.ProcessEnv;
  }>;
}
export interface Profile {
  directory: string;
  workspace: string;
  environment: NodeJS.ProcessEnv;
  sourceHome: string;
  sourceEnvironment: NodeJS.ProcessEnv;
}
export async function profile(
  context: RestrictedContext,
  id: string,
  options: OpenRestrictedOptions,
): Promise<Profile> {
  const root = Path.join(context.directory, id);
  await FS.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await FS.mkdtemp(Path.join(root, "run-"));
  const workspace = Path.join(directory, "workspace");
  await FS.mkdir(workspace, { recursive: true, mode: 0o700 });
  await FS.chmod(directory, 0o700);
  const sourceEnvironment = { ...process.env, ...options.env };
  const sourceHome = sourceEnvironment.HOME ?? sourceEnvironment.USERPROFILE ?? OS.homedir();
  const environment: NodeJS.ProcessEnv = {
    ...sourceEnvironment,
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: Path.join(directory, "config"),
    XDG_DATA_HOME: Path.join(directory, "data"),
    XDG_CACHE_HOME: Path.join(directory, "cache"),
  };
  // Do not attribute an internal native listener as an application preview server.
  delete environment.T3CODE_THREAD_ID;
  return { directory, workspace, environment, sourceHome, sourceEnvironment };
}
export async function copyCredential(source: string, target: string): Promise<void> {
  await FS.mkdir(Path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await FS.copyFile(source, target, FS.constants.COPYFILE_EXCL);
    await FS.chmod(target, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EEXIST") throw error;
  }
}
