import { QueryClientProvider } from "@tanstack/react-query";
import { appQueryClient } from "./app/query";
import { LocaleProvider } from "./i18n";
import { AppShell } from "./shell/AppShell";
import { AuthGate } from "./features/auth/AuthGate";

export { appQueryClient } from "./app/query";

export function App() {
  return (
    <LocaleProvider>
      <QueryClientProvider client={appQueryClient}>
        <AuthGate>
          <AppShell />
        </AuthGate>
      </QueryClientProvider>
    </LocaleProvider>
  );
}
