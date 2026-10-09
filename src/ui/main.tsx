import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { App } from "./App.tsx";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
