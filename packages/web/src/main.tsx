import { createRoot } from "react-dom/client";
import { App } from "./components/App";
import { log } from "./log";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("no #root element");

createRoot(rootEl).render(<App />);
log.info({ evt: "web.boot" });
