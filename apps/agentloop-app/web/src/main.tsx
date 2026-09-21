import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@zhujun/agentloop-artifact-preview/markdown.css";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
