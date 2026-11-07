import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@coven/ui-kit/theme.css";
import "./app.css";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
