export const connectorCredentialMessages: Readonly<Record<string, string>>;
export function connectorCredentialStatus(connection: {
  readonly credentialConfigured?: boolean;
  readonly unavailableReason?: string;
}): string;
