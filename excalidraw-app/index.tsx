import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import "../excalidraw-app/sentry";

import ExcalidrawApp from "./App";
import { registerAppUpdate } from "./data/appUpdate";

window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;
const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
// Do not reload an active note or generation automatically when a worker changes.
const updateSW = registerSW({
  onNeedRefresh() {
    /* The chat version banner offers an explicit refresh. */
  },
});
registerAppUpdate(async () => {
  const ownerWindow = rootElement.ownerDocument.defaultView!;
  const registration = await ownerWindow.navigator.serviceWorker
    ?.getRegistration()
    .catch(() => undefined);
  if (registration?.waiting) {
    // updateSW reloads only after the waiting worker has become the controller.
    await updateSW(true);
  } else {
    ownerWindow.location.reload();
  }
});
root.render(
  <StrictMode>
    <ExcalidrawApp />
  </StrictMode>,
);
