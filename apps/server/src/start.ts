import { buildApp } from "./app.js";
import { loadSystemConfig, resolveSystemConfigPath } from "./config.js";

const configPath = resolveSystemConfigPath(process.env, process.cwd());
const config = loadSystemConfig(configPath);
const app = buildApp({ logger: true });

await app.listen({
  host: config.runtime.serverHost,
  port: config.runtime.serverPort,
});
