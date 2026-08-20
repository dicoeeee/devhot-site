document.querySelectorAll("[data-source-coverage]").forEach((coverage) => {
  const trigger = coverage.querySelector("[data-source-coverage-trigger]");
  const dialog = coverage.querySelector("[data-source-coverage-dialog]");
  const closeButton = coverage.querySelector("[data-source-coverage-close]");

  if (
    !(trigger instanceof HTMLButtonElement) ||
    !(dialog instanceof HTMLDialogElement) ||
    !(closeButton instanceof HTMLButtonElement)
  ) {
    return;
  }

  trigger.addEventListener("click", () => {
    dialog.showModal();
    trigger.setAttribute("aria-expanded", "true");
  });

  closeButton.addEventListener("click", () => {
    dialog.close();
  });

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  dialog.addEventListener("close", () => {
    trigger.setAttribute("aria-expanded", "false");
    trigger.focus();
  });
});
