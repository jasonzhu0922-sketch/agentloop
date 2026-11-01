# Local Connector Configuration

Personal Connectors are configured inside the Local Agent. Cloud Runtime does not
load or resolve these connections.

## 飞书：扫码授权

飞书面向个人用户的连接使用 OAuth。用户不复制 access token，也不在浏览器
或 Runtime JSON 中填写 token；点击“连接飞书”后扫码登录并确认只读文档权限，
Local Agent 会把 user access token 和 refresh token 写入本机加密 Secret Store。

首次部署需要由部署方在[飞书开放平台](https://open.feishu.cn/app)创建商店/ISV
应用（应用凭据属于部署方，不属于最终用户），按[网页扫码登录指南](https://open.feishu.cn/document/qr-code-scanning-login-for-web-app/introduction)
配置网页能力，并登记回调地址：

```text
http://127.0.0.1:18790/v1/local-connectors/feishu/callback
```

将 `FEISHU_OAUTH_APP_ID`、`FEISHU_OAUTH_APP_SECRET`、
`FEISHU_OAUTH_REDIRECT_URI` 和应用权限目录中实际可用的最小用户级文档只读
权限配置到 Local Agent 私有 `.env`。商店/ISV 应用默认使用
`https://open.feishu.cn/open-apis/auth/v3/app_access_token`；如果测试的是
飞书企业自建应用，才将 `FEISHU_OAUTH_APP_ACCESS_TOKEN_URL` 覆盖为
`https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal`。

普通用户的完整流程只有：打开 Connector 设置 → 连接飞书 → 扫码登录 → 确认
授权。授权码只在 Local Agent 回调中兑换，refresh token 轮换也由 Local Agent
完成，不上传到 Router 或云端。

## 126 邮箱：账号 + 客户端授权码

126 邮箱的第三方客户端入口仍是 IMAP/POP3/SMTP 协议和客户端授权码。请在
[126 邮箱帮助中心](https://help.mail.126.com/faq.do?categoryID=90&m=list)
的“客户端协议”中开启 IMAP，并新增客户端授权码，然后在 Connector 设置中
填写邮箱地址和授权码。IMAP 服务器实测宣告 `AUTH=XOAUTH2`；但 AgentLoop
申请第三方应用资格、授权端点与回调的完整流程尚未验证，不能据此宣称已支持
普通用户扫码 OAuth，也不能断言服务器不支持 OAuth。

因此当前 126 Connector 保持本机加密保存账号+客户端授权码、通过
`imap.126.com:993/TLS` 只读读取邮件。第三方应用接入资格与完整授权链路
验证通过后，再实现独立的 126 OAuth 服务。

## API

For a local Runtime:

```text
GET    /v1/local-runtimes/:runtimeId/connectors
POST   /v1/local-runtimes/:runtimeId/connectors
DELETE /v1/local-runtimes/:runtimeId/connectors/:connectorId
```

Example:

```json
{
  "connector": {
    "connectorKey": "feishu",
    "displayName": "我的飞书",
    "modulePath": "/opt/agentloop/connectors/feishu/dist/index.js",
    "exportName": "feishuConnector",
    "enabled": true,
    "config": {},
    "externalAccountId": "account-1",
    "scopes": ["document:read"],
    "credentialConfigured": true
  }
}
```

The credential is written to the encrypted Local Agent secret store. The
configuration response only returns `credentialConfigured`, never the secret.

The Local Runtime loads enabled Connector modules and their Connection records
when it creates a Runtime. A Runtime restart is required after changing module
registration or connection configuration in the current foundation version.

At Run admission, both Router dispatch and strict-local HTTP default to the
enabled Connection IDs loaded for that exact Runtime. An explicit selection is
preserved, including `[]` to disable Connectors for the Run. Connection IDs do
not replace authorization: the Runtime's resolver still enforces its local
connection boundary.

Connectors expose declared capabilities through the common ToolSource catalog.
The planner/model discovers capabilities and chooses operations from this
catalog; admission must not route tasks by provider names, email keywords or
hardcoded tool calls. Enabling a Connector makes it discoverable, not mandatory.

The shared encrypted vault's startup cleanup includes references from every
registered owner, including disabled Connectors and connections in other
Runtimes. If reference enumeration fails, cleanup aborts before deleting secrets.
Settings verify the referenced secret exists instead of reporting a stale
database reference as a configured credential.
