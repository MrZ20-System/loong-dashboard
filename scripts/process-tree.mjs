import { spawn, spawnSync } from "node:child_process";

const supportsProcessDiscovery = process.platform !== "win32";
const supportsProcessGroups = process.platform !== "win32";
const knownProcessTrees = new WeakMap();

export function spawnProcessTree(executable, argumentsList, options) {
  return spawn(executable, argumentsList, {
    ...options,
    detached: supportsProcessGroups,
  });
}

export function signalProcessTree(child, signal) {
  if (!child || child.pid === undefined) return false;

  if (supportsProcessGroups) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // Managed environments can deny group signals. Fall back to the owned
      // positive PIDs discovered below.
    }
  }

  let discoveryError;
  let processIds;
  try {
    processIds = discoverProcessTree(child);
  } catch (error) {
    discoveryError = error;
    processIds = [child.pid];
  }
  let signaled = false;
  let signalError;
  for (const processId of processIds) {
    if (processId === child.pid && rootHasExited(child)) continue;
    try {
      process.kill(processId, signal);
      signaled = true;
    } catch (error) {
      if (!isMissingProcess(error)) signalError ??= error;
    }
  }
  if (discoveryError !== undefined) throw discoveryError;
  if (signalError !== undefined) throw signalError;
  return signaled;
}

export async function terminateProcessTree(
  child,
  { gracefulTimeoutMs = 5_000, killTimeoutMs = 5_000 } = {},
) {
  if (!child || child.pid === undefined) return;

  try {
    if (!signalProcessTree(child, "SIGTERM")) return;
  } catch (error) {
    await terminateKnownRoot(child, gracefulTimeoutMs, killTimeoutMs);
    throw new Error(
      `process tree ${child.pid} could not be safely discovered or signaled`,
      { cause: error },
    );
  }
  if (await waitForProcessTreeExit(child, gracefulTimeoutMs)) return;

  signalProcessTree(child, "SIGKILL");
  if (!(await waitForProcessTreeExit(child, killTimeoutMs))) {
    throw new Error(`process tree ${child.pid} did not exit after SIGKILL`);
  }
}

function processTreeIsAlive(child) {
  if (supportsProcessGroups) {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      // Fall through when group inspection is denied or the group is gone.
    }
  }

  const processIds = discoverProcessTree(child);
  for (const processId of processIds) {
    if (processId === child.pid && rootHasExited(child)) continue;
    try {
      process.kill(processId, 0);
      return true;
    } catch (error) {
      if (isMissingProcess(error)) continue;
      throw error;
    }
  }
  return false;
}

function discoverProcessTree(child) {
  let processIds = knownProcessTrees.get(child);
  if (processIds === undefined) {
    processIds = new Set([child.pid]);
    knownProcessTrees.set(child, processIds);
  }
  if (!supportsProcessDiscovery || child.exitCode !== null) {
    return [...processIds];
  }

  const queue = [...processIds];
  for (const parentPid of queue) {
    for (const childPid of directChildren(parentPid)) {
      if (processIds.has(childPid)) continue;
      processIds.add(childPid);
      queue.push(childPid);
    }
  }
  return [...processIds];
}

function directChildren(parentPid) {
  const result = spawnSync("pgrep", ["-P", String(parentPid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status === 1) return [];
  if (result.error) {
    throw new Error(`unable to discover children of process ${parentPid}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(
      `unable to discover children of process ${parentPid}: pgrep exited ${String(result.status)}`,
    );
  }
  return result.stdout
    .split("\n")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

async function waitForProcessTreeExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processTreeIsAlive(child)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processTreeIsAlive(child);
}

async function terminateKnownRoot(child, gracefulTimeoutMs, killTimeoutMs) {
  if (!rootIsAlive(child)) return;
  signalKnownRoot(child, "SIGTERM");
  if (await waitForRootExit(child, gracefulTimeoutMs)) return;
  signalKnownRoot(child, "SIGKILL");
  await waitForRootExit(child, killTimeoutMs);
}

function signalKnownRoot(child, signal) {
  if (!rootIsAlive(child)) return;
  process.kill(child.pid, signal);
}

async function waitForRootExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!rootIsAlive(child)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !rootIsAlive(child);
}

function rootIsAlive(child) {
  if (rootHasExited(child)) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return false;
    throw error;
  }
}

function rootHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function isMissingProcess(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    error.code === "ESRCH"
  );
}
