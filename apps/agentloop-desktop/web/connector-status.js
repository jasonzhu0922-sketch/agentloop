export const connectorCredentialMessages = Object.freeze({
  connector_credentials_missing: '凭据文件丢失，请重新填写并保存。',
  connector_credential_key_missing: '加密主密钥缺失，请恢复原密钥；如无备份，需删除受影响的连接后重新配置。',
  connector_credentials_unreadable: '凭据无法解密或已损坏，请恢复原密钥和凭据备份，或删除受影响的连接后重新配置。',
});

export function connectorCredentialStatus(connection) {
  return connectorCredentialMessages[connection.unavailableReason]
    || (connection.credentialConfigured ? '凭据已保存' : '无凭据');
}
