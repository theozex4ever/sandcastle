/**
 * Browser entry for `sandcastle dashboard`. Bundled by tsup into
 * `dist/dashboard/app.js` (+ `app.css`); never part of the Node package API.
 */
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./app.css";

const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
