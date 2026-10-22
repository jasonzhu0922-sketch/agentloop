import metadata from "../../../package.json" with { type: "json" };

// The installer and the Agent must use the same release metadata, including
// version overrides applied to an isolated packaging checkout.
export const LOCAL_AGENT_VERSION = metadata.version;
