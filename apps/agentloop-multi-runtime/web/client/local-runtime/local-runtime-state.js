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
    agentHealth: undefined,
    agentConfig: undefined,
    agentStatus: "checking",
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
      this.agentHealth = undefined;
      this.agentConfig = undefined;
      this.agentStatus = "checking";
      this.agentInstallPoll = undefined;
      this.agentReprobe = undefined;
      this.hydratedPreferenceKey = "";
    },
  };
}
