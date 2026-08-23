export const externalMcpEnglish = {
  title: "Third-party MCP",
  description:
    "Allow approved agents to call a restricted, read-only Athena tool catalog through OAuth-protected MCP.",
  disabled: "Third-party MCP is disabled by the server feature flag.",
  tabs: { mcp: "Third-party MCP", legacy: "Legacy REST API" },
  tools: "Tools",
  workspaces: "Workspaces",
  clients: "MCP clients",
  grants: "Active grants",
  calls: "Recent calls",
  empty: "No MCP clients yet.",
  rotate: "Rotate secret",
  disable: "Disable",
  enable: "Enable",
  connection: { title: "Connection details" },
  create: {
    title: "Create MCP client",
    description:
      "Only explicitly selected read-only tools and workspaces are granted.",
    name: "Client name",
    type: "Client type",
    service: "Unattended service",
    interactive: "Interactive OAuth + PKCE",
    redirect: "Exact redirect URI",
    creating: "Creating...",
    submit: "Create client",
  },
  secret: {
    title: "Save this client secret now",
    description: "It is shown once and cannot be recovered.",
    saved: "I saved it",
  },
  consent: {
    title: "Authorize third-party MCP",
    description:
      "Choose the read-only Athena resources this client may access.",
    authorizing: "Authorizing...",
    authorize: "Authorize for 30 days",
    deny: "Deny",
  },
  emergency: {
    title: "Revoke all MCP grants?",
    description:
      "All current third-party MCP access will stop within 30 seconds.",
    confirm: "Revoke all",
  },
  legacy: {
    title: "Legacy REST API",
    description:
      "Existing keys continue to work. New broad-access keys can no longer be created; migrate integrations to Third-party MCP.",
    lastUsed: "Last used",
    never: "Never",
  },
};

export const externalMcpChinese = {
  title: "第三方 MCP",
  description:
    "通过 OAuth 认证，让获准的 Agent 调用 Athena 明确限定的只读工具。",
  disabled: "服务器尚未启用第三方 MCP 功能开关。",
  tabs: { mcp: "第三方 MCP", legacy: "旧版 REST API" },
  tools: "工具",
  workspaces: "工作区",
  clients: "MCP 客户端",
  grants: "有效授权",
  calls: "最近调用",
  empty: "尚未创建 MCP 客户端。",
  rotate: "轮换密钥",
  disable: "停用",
  enable: "启用",
  connection: { title: "连接信息" },
  create: {
    title: "创建 MCP 客户端",
    description: "仅授予明确选择的只读工具和工作区。",
    name: "客户端名称",
    type: "客户端类型",
    service: "无人值守服务",
    interactive: "交互式 OAuth + PKCE",
    redirect: "精确回调地址",
    creating: "正在创建…",
    submit: "创建客户端",
  },
  secret: {
    title: "请立即保存客户端密钥",
    description: "密钥只显示一次，之后无法找回。",
    saved: "我已保存",
  },
  consent: {
    title: "授权第三方 MCP",
    description: "选择该客户端可访问的 Athena 只读资源。",
    authorizing: "正在授权…",
    authorize: "授权 30 天",
    deny: "拒绝",
  },
  emergency: {
    title: "撤销全部 MCP 授权？",
    description: "所有第三方 MCP 访问将在 30 秒内停止。",
    confirm: "全部撤销",
  },
  legacy: {
    title: "旧版 REST API",
    description:
      "现有密钥继续可用，但不再创建新的广权限密钥。请迁移至第三方 MCP。",
    lastUsed: "最后使用",
    never: "从未使用",
  },
};
