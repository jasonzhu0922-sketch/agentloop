let dismissTimer;

export function clearToast() {
  clearTimeout(dismissTimer);
  document.getElementById("app-notifications").replaceChildren();
}

/** Transient confirmations and dismissible errors above the active dialog. */
export function showToast(message, kind = "success") {
  clearTimeout(dismissTimer);
  const container = document.getElementById("app-notifications");
  const toast = document.createElement("div");
  toast.className = `app-toast app-toast-${kind}`;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");
  const icon = document.createElement("span");
  icon.className = "app-toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = kind === "success" ? "✓" : "!";
  const content = document.createElement("p");
  content.textContent = message;
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "关闭提示");
  close.textContent = "×";
  close.addEventListener("click", () => { clearTimeout(dismissTimer); toast.remove(); });
  toast.append(icon, content, close);
  container.replaceChildren(toast);
  if (kind === "success") dismissTimer = setTimeout(() => toast.remove(), 4000);
}
