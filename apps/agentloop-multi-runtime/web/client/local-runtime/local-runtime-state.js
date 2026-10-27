/**
 * Browser-owned local execution state.
 *
 * Device identity, Local Agent lifecycle, Runtime selection, directory scopes,
 * and short-lived control timers belong to one local execution state machine.
 * Transport clients and DOM rendering remain outside this module.
 */
export function createLocalRuntimeState() {
  return {
    device: undefined,
    runtimeId: "",
    sessionRefresh: undefined,
    sessionRefreshTimer: undefined,
    scopes: [],
    runtimes: [],
    lifecycleOperations: {},
    agentHealth: undefined,
    agentConfig: undefined,
    agentStatus: "checking",
    deviceAccessChecked: false,
    agentInstallPoll: undefined,
    agentReprobe: undefined,
    hydratedPreferenceKey: "",
    clear() {
      this.device = undefined;
      this.runtimeId = "";
      this.sessionRefresh = undefined;
      this.sessionRefreshTimer = undefined;
      this.scopes = [];
      this.runtimes = [];
      this.lifecycleOperations = {};
      this.agentHealth = undefined;
      this.agentConfig = undefined;
      this.agentStatus = "checking";
      this.deviceAccessChecked = false;
      this.agentInstallPoll = undefined;
      if (this.agentReprobe) clearTimeout(this.agentReprobe);
      this.agentReprobe = undefined;
      this.hydratedPreferenceKey = "";
    },
  };
}
