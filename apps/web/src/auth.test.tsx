import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthGate } from "./features/auth/AuthGate";
import { SecuritySettings } from "./features/settings/SecuritySettings";
import { AUTH_REQUIRED_EVENT } from "./auth-required-event";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("password lock UI", () => {
  it("does not mount business content or query it while locked, then unlocks", async () => {
    let unlocked = false;
    const calls: Array<{ path: string; method: string }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      calls.push({ path: url.pathname, method: init?.method ?? "GET" });
      if (url.pathname === "/api/auth/status") {
        return json({ enabled: true, unlocked });
      }
      if (url.pathname === "/api/auth/unlock") {
        unlocked = true;
        return json({ enabled: true, unlocked: true });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthGate><div data-testid="business-content">Business</div></AuthGate>);

    expect(await screen.findByRole("heading", { name: "LoongBoard" })).toBeInTheDocument();
    expect(screen.queryByTestId("business-content")).not.toBeInTheDocument();
    expect(calls.map(({ path }) => path)).toEqual(["/api/auth/status"]);

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByTestId("business-content")).toBeInTheDocument();
    expect(calls).toContainEqual({ path: "/api/auth/unlock", method: "POST" });
    expect(calls.some(({ path }) => path.startsWith("/api/repositories"))).toBe(false);
  });

  it("changes and disables the lock from Security settings", async () => {
    const calls: Array<{ path: string; method: string; body?: string }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      calls.push({ path: url.pathname, method: init?.method ?? "GET", ...(init?.body === undefined ? {} : { body: String(init.body) }) });
      if (url.pathname === "/api/auth/status") return json({ enabled: true, unlocked: true });
      if (url.pathname === "/api/auth/password") return json({ enabled: true, unlocked: true });
      if (url.pathname === "/api/auth/disable") return json({ enabled: false, unlocked: true });
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SecuritySettings /></QueryClientProvider>);

    expect(await screen.findByLabelText("Current password")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(calls.some(({ path, method, body }) => path === "/api/auth/password" && method === "POST" && body === JSON.stringify({ password: "new", currentPassword: "old" }))).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Disable lock" }));
    await waitFor(() => expect(calls.some(({ path, method }) => path === "/api/auth/disable" && method === "POST")).toBe(true));
    expect(await screen.findByText("Password lock disabled.")).toBeInTheDocument();
    client.clear();
  });

  it("re-locks after a business request reports AUTH_REQUIRED and removes its listener", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/auth/status") {
        return json({ enabled: true, unlocked: true });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const rendered = render(<AuthGate><div data-testid="business-content">Business</div></AuthGate>);
    expect(await screen.findByTestId("business-content")).toBeInTheDocument();

    act(() => window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)));
    expect(await screen.findByRole("heading", { name: "LoongBoard" })).toBeInTheDocument();
    expect(screen.queryByTestId("business-content")).not.toBeInTheDocument();

    rendered.unmount();
    act(() => window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)));
  });
});
