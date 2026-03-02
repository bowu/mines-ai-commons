import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "katex/dist/katex.min.css";

// Production deploys can invalidate lazy-loaded chunk URLs in open tabs.
// When Vite reports a preload error, force a one-time hard reload.
if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", (event) => {
    try {
      event.preventDefault();
      const reloadKey = "vite-preload-reload-attempted";
      if (!window.sessionStorage.getItem(reloadKey)) {
        window.sessionStorage.setItem(reloadKey, "1");
        window.location.reload();
      }
    } catch {
      window.location.reload();
    }
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
