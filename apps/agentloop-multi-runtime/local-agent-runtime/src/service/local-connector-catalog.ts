import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface LocalConnectorCatalogItem {
  readonly key: string;
  readonly displayName: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly setupHint: string;
  readonly binding: {
    readonly kind?: "manual" | "oauth";
    readonly title: string;
    readonly description: string;
    readonly fields: readonly {
      readonly key: string;
      readonly label: string;
      readonly target: "credential" | "config";
      readonly secret?: boolean;
      readonly placeholder?: string;
    }[];
    readonly examples?: readonly string[];
  };
  readonly template: {
    readonly connectorKey: string;
    readonly displayName: string;
    readonly modulePath: string;
    readonly exportName: string;
    readonly enabled: boolean;
    readonly config: Readonly<Record<string, unknown>>;
    readonly scopes: readonly string[];
    readonly credentials?: Readonly<Record<string, string>>;
  };
}

/**
 * Built-in Connector choices exposed by the Local Agent UI.  The catalog owns
 * module locations so a user never has to discover installation paths or
 * export names.  Development uses the workspace sources; packaged Agents use
 * the self-contained Connector bundles shipped beside the Agent executable.
 */
export function localConnectorCatalog(appRoot: string): readonly LocalConnectorCatalogItem[] {
  const modulePath = (name: "feishu" | "126-mail" | "wps") => builtinModulePath(appRoot, name);
  return [
    {
      key: "feishu",
      displayName: "飞书",
      description: "搜索和读取已获授权的飞书文档。",
      capabilities: ["文档搜索", "文档读取"],
      setupHint: "使用飞书应用授权令牌绑定；当前仅提供只读访问。",
      binding: {
        title: "绑定飞书",
        description: "请粘贴由飞书应用 OAuth 流程取得的用户 access token。完整的网页 OAuth 跳转将在 Local Agent 配置飞书应用 Client ID 与回调地址后启用。",
        fields: [{ key: "accessToken", label: "用户 Access Token", target: "credential", secret: true, placeholder: "粘贴飞书 OAuth access token" }],
      },
      template: {
        connectorKey: "feishu",
        displayName: "我的飞书",
        modulePath: modulePath("feishu"),
        exportName: "feishuConnector",
        enabled: false,
        config: {},
        scopes: ["document:search", "document:read"],
      },
    },
    {
      key: "126-mail",
      displayName: "126 邮箱",
      description: "搜索和读取已授权的 126 邮件。",
      capabilities: ["邮件搜索", "邮件读取"],
      setupHint: "填写 126 邮箱账号和在邮箱设置中生成的客户端授权码；默认通过 imap.126.com:993/TLS 只读连接。",
      binding: {
        title: "绑定 126 邮箱",
        description: "请先在 126 邮箱设置中开启 IMAP/SMTP，并生成客户端授权码。该授权码仅保存在这台设备的加密 Secret Store 中。",
        fields: [
          { key: "email", label: "126 邮箱账号", target: "credential", placeholder: "name@126.com" },
          { key: "authorizationCode", label: "客户端授权码", target: "credential", secret: true, placeholder: "粘贴授权码，不是网页登录密码" },
        ],
      },
      template: {
        connectorKey: "126-mail",
        displayName: "我的 126 邮箱",
        modulePath: modulePath("126-mail"),
        exportName: "createConfigured126MailConnector",
        enabled: false,
        config: {},
        scopes: ["email:search", "email:read"],
      },
    },
    {
      key: "kingsoft-wps",
      displayName: "金山文档",
      description: "搜索和读取金山在线文档、表格。",
      capabilities: ["文档搜索", "文档读取", "表格读取"],
      setupHint: "在金山文档授权页确认后即可绑定；凭据仅保存在这台设备。",
      binding: {
        kind: "oauth",
        title: "连接 金山文档 | WPS 云文档",
        description: "授权后可读取你允许 AgentLoop 访问的金山文档与云表格。授权令牌只保存在本机加密 Secret Store，不会上传到云端。",
        fields: [],
        examples: ["搜索我的项目周报与相关文档", "读取这份金山表格并汇总关键数据", "把指定金山文档转换为 Markdown 摘要"],
      },
      template: {
        connectorKey: "kingsoft-wps",
        displayName: "我的金山文档",
        modulePath: modulePath("wps"),
        exportName: "createConfiguredWpsConnector",
        enabled: false,
        config: {},
        scopes: ["document:search", "document:read", "spreadsheet:read"],
      },
    },
  ];
}

function builtinModulePath(appRoot: string, name: "feishu" | "126-mail" | "wps"): string {
  const packaged = join(appRoot, "connectors", `${name}.mjs`);
  if (existsSync(packaged)) return packaged;
  const packageName = name === "126-mail" ? "connector-126-mail" : `connector-${name}`;
  return resolve(appRoot, "..", "..", "packages", packageName, "src", "index.ts");
}
