import { QueryClientProvider } from "@tanstack/react-query";
import { appQueryClient } from "./app/query";
import { AppShell } from "./shell/AppShell";

export { appQueryClient } from "./app/query";

export function App() {
  return (
    <QueryClientProvider client={appQueryClient}>
      <AppShell />
    </QueryClientProvider>
  );
}
