import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { App } from "./App.tsx";
import { initTheme } from "./theme.ts";

// Before render, so the first paint is already in the right palette.
initTheme();

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
