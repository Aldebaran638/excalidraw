// The worker may prepare an update, but only an explicit user action applies it.
let applyWorkerUpdate: (() => Promise<void>) | undefined;
export const registerAppUpdate = (apply: () => Promise<void>) => {
  applyWorkerUpdate = apply;
};
export const applyAppUpdate = async (ownerWindow: Window) => {
  if (applyWorkerUpdate) {
    await applyWorkerUpdate();
  } else {
    ownerWindow.location.reload();
  }
};
