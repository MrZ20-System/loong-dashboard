import { authFilePath, resetAuthFile } from "./auth.js";
import { loadSystemConfig, resolveSystemConfigPath } from "./config.js";

/**
 * Local recovery entry point. It resolves the same configuration as the
 * server, then removes only the exact statePath/auth.json file.
 */
try {
  const environment = process.env;
  const configPath = resolveSystemConfigPath(environment, process.cwd());
  const config = loadSystemConfig(configPath, environment);
  const removed = resetAuthFile(authFilePath(config.runtime.statePath));
  process.stdout.write(removed ? "Password lock reset.\n" : "Password lock already off.\n");
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : "Unable to reset password lock"}\n`);
  process.exitCode = 1;
}
