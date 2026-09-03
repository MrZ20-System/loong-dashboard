import { createServerRuntime } from "./runtime.js";

const runtime = createServerRuntime({ appOptions: { logger: true } });

await runtime.app.listen({
  host: runtime.config.runtime.serverHost,
  port: runtime.config.runtime.serverPort,
});
