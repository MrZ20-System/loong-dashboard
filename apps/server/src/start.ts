import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServerRuntime } from "./runtime.js";
import { installSignalHandlers } from "./lifecycle.js";

const serverDistRoot = dirname(fileURLToPath(import.meta.url));
const webDistRoot = resolve(serverDistRoot, "../../web/dist");
const runtime = createServerRuntime({
  appOptions: { logger: true, staticRoot: webDistRoot },
});
installSignalHandlers(() => runtime.app.close());

await runtime.app.listen({
  host: runtime.config.runtime.serverHost,
  port: runtime.config.runtime.serverPort,
});
