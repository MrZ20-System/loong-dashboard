import { QueryClientProvider } from "@tanstack/react-query";
import { appQueryClient } from "./app/query";
import { AppShell } from "./shell/AppShell";
import { AuthGate } from "./features/auth/AuthGate";

export { appQueryClient } from "./app/query";

export function App() {
  return (
    <QueryClientProvider client={appQueryClient}>
      <AuthGate>
        <AppShell />
      </AuthGate>
    </QueryClientProvider>
  );
}
