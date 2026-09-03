import { createServerRuntime } from "./runtime.js";
import { installSignalHandlers } from "./lifecycle.js";

const runtime = createServerRuntime({ appOptions: { logger: true } });
installSignalHandlers(() => runtime.app.close());

await runtime.app.listen({
  host: runtime.config.runtime.serverHost,
  port: runtime.config.runtime.serverPort,
});
