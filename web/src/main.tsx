import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 2_000, refetchOnWindowFocus: true, retry: 1 } } });

async function start() {
  // Static demo build (pnpm build:demo): answer the API from a recording before the first query runs.
  if (import.meta.env.VITE_ORYS_DEMO === "1") await (await import("./demo/install")).installDemo();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void start();
