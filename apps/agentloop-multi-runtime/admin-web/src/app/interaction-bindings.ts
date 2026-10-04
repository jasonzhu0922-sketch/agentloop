import { clearAdminSession } from "./session-state.ts";
import { toggleSidebarGroup } from "./sidebar.ts";
import type { Page } from "./navigation.ts";
import type { UiState } from "./ui-state.ts";

export interface AdminShellBindingHandlers {
  readonly state: UiState;
  readonly render: (root: HTMLElement) => void;
  readonly login: (event: SubmitEvent, root: HTMLElement) => void | Promise<void>;
  readonly saveModel: (event: SubmitEvent, root: HTMLElement) => void | Promise<void>;
  readonly saveProvider: (event: SubmitEvent, root: HTMLElement) => void | Promise<void>;
  readonly setDefaultProvider: (providerKey: string, root: HTMLElement) => void | Promise<void>;
  readonly deleteModel: (modelKey: string, root: HTMLElement) => void | Promise<void>;
  readonly selectSkill: (name: string, root: HTMLElement) => void | Promise<void>;
  readonly changeSkillPage: (page: number, root: HTMLElement) => void | Promise<void>;
  readonly selectRun: (id: string, root: HTMLElement) => void | Promise<void>;
  readonly changeRunPage: (page: number, root: HTMLElement) => void | Promise<void>;
  readonly createMember: (event: SubmitEvent, root: HTMLElement) => void | Promise<void>;
  readonly saveAdminUser: (event: SubmitEvent, root: HTMLElement) => void | Promise<void>;
  readonly transitionAdminUser: (button: HTMLElement, root: HTMLElement) => void | Promise<void>;
  readonly changeAdminUserPage: (page: number, root: HTMLElement) => void;
  readonly runtimeRowOperation: (button: HTMLElement, root: HTMLElement) => void | Promise<void>;
  readonly changeRuntimePage: (page: number, root: HTMLElement) => void | Promise<void>;
  readonly traceRun: (event: SubmitEvent, root: HTMLElement) => void | Promise<void>;
  readonly transitionMember: (button: HTMLElement, root: HTMLElement) => void | Promise<void>;
  readonly suspendBusinessUser: (id: string, root: HTMLElement) => void | Promise<void>;
  readonly resetBusinessPassword: (event: SubmitEvent, root: HTMLElement) => void | Promise<void>;
}

/** Central event wiring for the shell. Page operations remain injected so the
 * shell no longer owns a second, implicit page-component lifecycle. */
export function bindAdminShell(root: HTMLElement, handlers: AdminShellBindingHandlers): void {
  const { state, render } = handlers;
  if (state.session !== undefined && root.querySelector("[data-action=sign-out]") === null) root.insertAdjacentHTML("afterbegin", `<button class="admin-logout-floating ghost" style="position:fixed;right:28px;top:24px;z-index:20" data-action="sign-out">退出登录</button>`);
  root.querySelectorAll<HTMLElement>("[data-page]").forEach((button) => button.addEventListener("click", () => { state.page = button.dataset.page as Page; state.error = undefined; render(root); }));
  root.querySelectorAll<HTMLElement>("[data-nav-group]").forEach((button) => button.addEventListener("click", () => { toggleSidebarGroup(button.dataset.navGroup!); render(root); }));
  root.querySelector<HTMLElement>("[data-action=sign-out]")?.addEventListener("click", () => { clearAdminSession(localStorage); state.token = ""; state.session = undefined; state.error = undefined; state.degradedErrors = []; state.notice = "已退出登录"; render(root); });
  root.querySelector<HTMLFormElement>("#login-form")?.addEventListener("submit", (event) => void handlers.login(event, root));
  root.querySelector<HTMLFormElement>("#model-form")?.addEventListener("submit", (event) => void handlers.saveModel(event, root));
  root.querySelector<HTMLFormElement>("#provider-form")?.addEventListener("submit", (event) => void handlers.saveProvider(event, root));
  root.querySelector<HTMLElement>("[data-action=new-provider]")?.addEventListener("click", () => { state.providerEditingKey = undefined; state.providerModal = true; render(root); });
  root.querySelectorAll<HTMLElement>("[data-action=cancel-provider]").forEach((button) => button.addEventListener("click", () => { state.providerEditingKey = undefined; state.providerModal = false; render(root); }));
  root.querySelectorAll<HTMLElement>("[data-provider-edit]").forEach((button) => button.addEventListener("click", () => { state.providerEditingKey = button.dataset.providerEdit; state.providerModal = true; render(root); }));
  root.querySelectorAll<HTMLElement>("[data-provider-default]").forEach((button) => button.addEventListener("click", () => void handlers.setDefaultProvider(button.dataset.providerDefault!, root)));
  root.querySelector<HTMLElement>("[data-action=new-model]")?.addEventListener("click", () => { state.modelEditingKey = undefined; state.modelProviderKey = state.providers[0]?.key; state.modelModal = state.providers.length > 0; render(root); });
  root.querySelectorAll<HTMLElement>("[data-action=cancel-model]").forEach((button) => button.addEventListener("click", () => { state.modelEditingKey = undefined; state.modelProviderKey = undefined; state.modelModal = false; render(root); }));
  root.querySelector<HTMLElement>("[data-action=add-model-parameter]")?.addEventListener("click", () => { root.querySelector<HTMLElement>("#model-parameters")?.insertAdjacentHTML("beforeend", `<div class="model-parameter-row"><input name="parameterKey" placeholder="参数名"><input name="parameterValue" placeholder='字符串或 JSON，例如 {"thinking":false}'><button class="text-button" type="button" data-action="remove-model-parameter" aria-label="删除参数">×</button></div>`); });
  root.querySelectorAll<HTMLElement>("[data-action=remove-model-parameter]").forEach((button) => button.addEventListener("click", () => button.parentElement?.remove()));
  root.querySelectorAll<HTMLElement>("[data-model-edit]").forEach((button) => button.addEventListener("click", () => { const model = state.models.find((item) => item.key === button.dataset.modelEdit); state.modelEditingKey = button.dataset.modelEdit; state.modelProviderKey = model?.providerKey; state.modelModal = model !== undefined; render(root); }));
  root.querySelectorAll<HTMLElement>("[data-model-delete]").forEach((button) => button.addEventListener("click", () => void handlers.deleteModel(button.dataset.modelDelete!, root)));
  root.querySelectorAll<HTMLElement>("[data-provider-add-model]").forEach((button) => button.addEventListener("click", () => { state.modelEditingKey = undefined; state.modelProviderKey = button.dataset.providerAddModel; state.modelModal = true; render(root); }));
  root.querySelectorAll<HTMLElement>("[data-skill-name]").forEach((button) => button.addEventListener("click", () => void handlers.selectSkill(button.dataset.skillName!, root)));
  root.querySelector<HTMLElement>("[data-action=skill-page-prev]")?.addEventListener("click", () => void handlers.changeSkillPage(state.skillPage - 1, root));
  root.querySelector<HTMLElement>("[data-action=skill-page-next]")?.addEventListener("click", () => void handlers.changeSkillPage(state.skillPage + 1, root));
  root.querySelectorAll<HTMLElement>("[data-run-id]").forEach((row) => row.addEventListener("click", () => void handlers.selectRun(row.dataset.runId!, root)));
  root.querySelectorAll<HTMLElement>("[data-action=close-run-detail]").forEach((button) => button.addEventListener("click", () => { state.runDetail = undefined; render(root); }));
  root.querySelector<HTMLElement>("[data-action=run-page-prev]")?.addEventListener("click", () => void handlers.changeRunPage(state.runPage - 1, root));
  root.querySelector<HTMLElement>("[data-action=run-page-next]")?.addEventListener("click", () => void handlers.changeRunPage(state.runPage + 1, root));
  root.querySelector<HTMLFormElement>("#member-form")?.addEventListener("submit", (event) => void handlers.createMember(event, root));
  root.querySelector<HTMLFormElement>("#admin-user-form")?.addEventListener("submit", (event) => void handlers.saveAdminUser(event, root));
  root.querySelectorAll<HTMLElement>("[data-action=cancel-user-edit]").forEach((button) => button.addEventListener("click", () => { state.userEditingId = undefined; state.userModal = false; render(root); }));
  root.querySelectorAll<HTMLElement>("[data-user-edit]").forEach((button) => button.addEventListener("click", () => { state.userEditingId = button.dataset.userEdit; state.userModal = true; render(root); }));
  root.querySelectorAll<HTMLElement>("[data-user-transition]").forEach((button) => button.addEventListener("click", () => void handlers.transitionAdminUser(button, root)));
  root.querySelector<HTMLElement>("[data-action=new-user]")?.addEventListener("click", () => { state.userEditingId = undefined; state.userModal = true; render(root); });
  root.querySelector<HTMLElement>("[data-action=admin-user-page-prev]")?.addEventListener("click", () => handlers.changeAdminUserPage(state.userPage - 1, root));
  root.querySelector<HTMLElement>("[data-action=admin-user-page-next]")?.addEventListener("click", () => handlers.changeAdminUserPage(state.userPage + 1, root));
  root.querySelectorAll<HTMLElement>("[data-runtime-operation]").forEach((button) => button.addEventListener("click", () => void handlers.runtimeRowOperation(button, root)));
  root.querySelector<HTMLElement>("[data-action=runtime-page-prev]")?.addEventListener("click", () => void handlers.changeRuntimePage(state.runtimePage - 1, root));
  root.querySelector<HTMLElement>("[data-action=runtime-page-next]")?.addEventListener("click", () => void handlers.changeRuntimePage(state.runtimePage + 1, root));
  root.querySelector<HTMLFormElement>("#trace-form")?.addEventListener("submit", (event) => void handlers.traceRun(event, root));
  root.querySelectorAll<HTMLElement>("[data-member-transition]").forEach((button) => button.addEventListener("click", () => void handlers.transitionMember(button, root)));
  root.querySelectorAll<HTMLElement>("[data-business-suspend]").forEach((button) => button.addEventListener("click", () => void handlers.suspendBusinessUser(button.dataset.businessSuspend!, root)));
  root.querySelectorAll<HTMLElement>("[data-business-password]").forEach((button) => button.addEventListener("click", () => { state.businessUserPasswordId = button.dataset.businessPassword; render(root); }));
  root.querySelectorAll<HTMLElement>("[data-action=cancel-business-password]").forEach((button) => button.addEventListener("click", () => { state.businessUserPasswordId = undefined; render(root); }));
  root.querySelector<HTMLFormElement>("#business-password-form")?.addEventListener("submit", (event) => void handlers.resetBusinessPassword(event, root));
}
