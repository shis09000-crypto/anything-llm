import { useEffect, useMemo, useState } from "react";
import * as Skeleton from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";
import {
  ArrowsClockwise,
  Copy,
  Key,
  Plug,
  Prohibit,
  Trash,
} from "@phosphor-icons/react";
import Admin from "@/models/admin";
import System from "@/models/system";
import { baseHeaders, userFromStorage } from "@/utils/request";
import { useTranslation } from "react-i18next";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import {
  SoftButton,
  SoftCard,
  SoftSettingsLayout,
} from "@/components/SoftSettings";

const fieldClass =
  "w-full rounded-xl border border-[var(--soft-border)] bg-[var(--soft-control)] px-3 py-2 text-sm text-theme-text-primary outline-none focus:border-[#2152ff]";

function useCopy() {
  const { t } = useTranslation();
  return (key, fallback, values = {}) =>
    t(key, { defaultValue: fallback, ...values });
}

function CopyValue({ value }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-xl bg-[var(--soft-control)] px-3 py-2">
      <code className="min-w-0 flex-1 truncate text-xs">{value}</code>
      <button
        type="button"
        className="shrink-0 text-[#2152ff]"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1800);
        }}
      >
        {copied ? "✓" : <Copy size={18} />}
      </button>
    </div>
  );
}

function ToolWorkspacePicker({
  config,
  tools,
  setTools,
  workspaceIds,
  setWorkspaceIds,
}) {
  const c = useCopy();
  return (
    <>
      <div>
        <p className="mb-2 text-sm font-semibold">
          {c("externalMcp.tools", "Tools")}
        </p>
        <div className="grid gap-2 md:grid-cols-2">
          {config.tools.map((tool) => (
            <label key={tool.name} className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={tools.includes(tool.name)}
                onChange={(event) =>
                  setTools((current) =>
                    event.target.checked
                      ? [...current, tool.name]
                      : current.filter((name) => name !== tool.name)
                  )
                }
              />
              <span>
                <code>{tool.name}</code>
                <span className="block text-xs text-theme-text-secondary">
                  {tool.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-2 text-sm font-semibold">
          {c("externalMcp.workspaces", "Workspaces")}
        </p>
        <div className="grid gap-2 md:grid-cols-2">
          {config.workspaces.map((workspace) => (
            <label key={workspace.id} className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={workspaceIds.includes(workspace.id)}
                onChange={(event) =>
                  setWorkspaceIds((current) =>
                    event.target.checked
                      ? [...current, workspace.id]
                      : current.filter((id) => id !== workspace.id)
                  )
                }
              />
              <span>{workspace.name}</span>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

function AuthorizationConsent({ params }) {
  const c = useCopy();
  const [preview, setPreview] = useState(null);
  const [tools, setTools] = useState([]);
  const [workspaceIds, setWorkspaceIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    System.externalMcpAuthorizePreview(
      params.get("client_id"),
      params.get("scope")
    ).then((data) => {
      if (!active) return;
      if (!data?.success) return setError(data?.error || "invalid_client");
      setPreview(data);
      setTools(data.tools.map((tool) => tool.name));
      setWorkspaceIds(data.workspaces.map((workspace) => workspace.id));
    });
    return () => {
      active = false;
    };
  }, [params]);
  async function authorize() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/oauth/mcp/authorize", {
        method: "POST",
        headers: { ...baseHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: params.get("client_id"),
          redirect_uri: params.get("redirect_uri"),
          response_type: params.get("response_type"),
          state: params.get("state"),
          code_challenge: params.get("code_challenge"),
          code_challenge_method: params.get("code_challenge_method"),
          scope: preview.scopes.join(" "),
          tools,
          workspaceIds,
          expiresInDays: 30,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.redirect)
        throw new Error(
          data.error_description || data.error || "authorization_failed"
        );
      window.location.assign(data.redirect);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  async function deny() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/oauth/mcp/authorize", {
        method: "POST",
        headers: { ...baseHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: params.get("client_id"),
          redirect_uri: params.get("redirect_uri"),
          response_type: params.get("response_type"),
          state: params.get("state"),
          code_challenge: params.get("code_challenge"),
          code_challenge_method: params.get("code_challenge_method"),
          decision: "deny",
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.redirect)
        throw new Error(
          data.error_description || data.error || "authorization_failed"
        );
      window.location.assign(data.redirect);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  return (
    <SoftSettingsLayout
      title={c("externalMcp.consent.title", "Authorize third-party MCP")}
      description={c(
        "externalMcp.consent.description",
        "Choose the read-only Athena resources this client may access."
      )}
    >
      <SoftCard title={preview?.client?.name || c("common.loading", "Loading")}>
        {error && <p className="mb-4 text-sm text-red-500">{error}</p>}
        {preview && (
          <div className="space-y-5">
            <ToolWorkspacePicker
              config={preview}
              tools={tools}
              setTools={setTools}
              workspaceIds={workspaceIds}
              setWorkspaceIds={setWorkspaceIds}
            />
            <div className="flex flex-wrap gap-2">
              <SoftButton disabled={busy || !tools.length} onClick={authorize}>
                {busy
                  ? c("externalMcp.consent.authorizing", "Authorizing...")
                  : c("externalMcp.consent.authorize", "Authorize for 30 days")}
              </SoftButton>
              <SoftButton variant="outline" disabled={busy} onClick={deny}>
                {c("externalMcp.consent.deny", "Deny")}
              </SoftButton>
            </div>
          </div>
        )}
      </SoftCard>
    </SoftSettingsLayout>
  );
}

export function ExternalMcpAuthorizationConsent() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  return <AuthorizationConsent params={params} />;
}

function CreateClient({ config, onCreated }) {
  const c = useCopy();
  const [name, setName] = useState("");
  const [clientType, setClientType] = useState("service");
  const [redirectUri, setRedirectUri] = useState("");
  const [tools, setTools] = useState([]);
  const [workspaceIds, setWorkspaceIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const result = await System.createExternalMcpClient({
      name,
      clientType,
      redirectUris: clientType === "interactive" ? [redirectUri] : [],
      tools,
      workspaceIds,
      expiresInDays: 30,
    });
    setBusy(false);
    if (!result?.success) return setError(result?.error || "create_failed");
    setName("");
    setRedirectUri("");
    setTools([]);
    setWorkspaceIds([]);
    onCreated(result);
  }
  return (
    <SoftCard
      title={c("externalMcp.create.title", "Create MCP client")}
      description={c(
        "externalMcp.create.description",
        "Only explicitly selected read-only tools and workspaces are granted."
      )}
    >
      <form className="space-y-4" onSubmit={submit}>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span>{c("externalMcp.create.name", "Client name")}</span>
            <input
              className={fieldClass}
              value={name}
              required
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span>{c("externalMcp.create.type", "Client type")}</span>
            <select
              className={fieldClass}
              value={clientType}
              onChange={(e) => setClientType(e.target.value)}
            >
              <option value="service">
                {c("externalMcp.create.service", "Unattended service")}
              </option>
              <option value="interactive">
                {c(
                  "externalMcp.create.interactive",
                  "Interactive OAuth + PKCE"
                )}
              </option>
            </select>
          </label>
        </div>
        {clientType === "interactive" && (
          <label className="block space-y-1 text-sm">
            <span>
              {c("externalMcp.create.redirect", "Exact redirect URI")}
            </span>
            <input
              className={fieldClass}
              type="url"
              value={redirectUri}
              required
              onChange={(e) => setRedirectUri(e.target.value)}
            />
          </label>
        )}
        <ToolWorkspacePicker
          config={config}
          tools={tools}
          setTools={setTools}
          workspaceIds={workspaceIds}
          setWorkspaceIds={setWorkspaceIds}
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
        <SoftButton type="submit" disabled={busy || !tools.length}>
          <Plug size={18} />
          {busy
            ? c("externalMcp.create.creating", "Creating...")
            : c("externalMcp.create.submit", "Create client")}
        </SoftButton>
      </form>
    </SoftCard>
  );
}

function ThirdPartyMcp() {
  const c = useCopy();
  const [config, setConfig] = useState(null);
  const [secret, setSecret] = useState(null);
  async function refresh() {
    setConfig(await System.externalMcpConfig());
  }
  useEffect(() => {
    refresh();
  }, []);
  if (!config)
    return (
      <Skeleton.default height={280} count={2} className="mb-4 rounded-2xl" />
    );
  if (!config.success)
    return (
      <SoftCard>
        <p className="text-sm text-red-500">{config.error}</p>
      </SoftCard>
    );
  return (
    <div className="space-y-4">
      {!config.enabled && (
        <SoftCard>
          <p className="text-sm text-amber-600">
            {c(
              "externalMcp.disabled",
              "Third-party MCP is disabled by the server feature flag."
            )}
          </p>
        </SoftCard>
      )}
      <SoftCard title={c("externalMcp.connection.title", "Connection details")}>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <p className="mb-1 text-xs text-theme-text-secondary">
              MCP Endpoint
            </p>
            <CopyValue value={config.endpoint} />
          </div>
          <div>
            <p className="mb-1 text-xs text-theme-text-secondary">
              OAuth Metadata
            </p>
            <CopyValue value={config.protectedResourceMetadata} />
          </div>
        </div>
      </SoftCard>
      {secret && (
        <SoftCard
          title={c("externalMcp.secret.title", "Save this client secret now")}
          description={c(
            "externalMcp.secret.description",
            "It is shown once and cannot be recovered."
          )}
        >
          <CopyValue value={secret} />
          <SoftButton
            className="mt-3"
            variant="outline"
            onClick={() => setSecret(null)}
          >
            {c("externalMcp.secret.saved", "I saved it")}
          </SoftButton>
        </SoftCard>
      )}
      <CreateClient
        config={config}
        onCreated={(result) => {
          setSecret(result.clientSecret || null);
          refresh();
        }}
      />
      <SoftCard title={c("externalMcp.clients", "MCP clients")}>
        <div className="space-y-3">
          {!config.clients.length && (
            <p className="text-sm text-theme-text-secondary">
              {c("externalMcp.empty", "No MCP clients yet.")}
            </p>
          )}
          {config.clients.map((client) => (
            <div
              key={client.clientId}
              className="flex flex-col gap-3 rounded-xl border border-[var(--soft-border)] p-3 md:flex-row md:items-center"
            >
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{client.name}</p>
                <p className="truncate font-mono text-xs text-theme-text-secondary">
                  {client.clientId}
                </p>
                <p className="text-xs text-theme-text-secondary">
                  {client.clientType} · {client.status} ·{" "}
                  {client.maxTools.length} tools
                </p>
              </div>
              <div className="flex gap-2">
                {client.clientType === "service" && (
                  <SoftButton
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const result = await System.rotateExternalMcpClient(
                        client.clientId
                      );
                      if (result.success) setSecret(result.clientSecret);
                    }}
                  >
                    <ArrowsClockwise size={16} />
                    {c("externalMcp.rotate", "Rotate secret")}
                  </SoftButton>
                )}
                <SoftButton
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await System.setExternalMcpClientStatus(
                      client.clientId,
                      client.status === "active" ? "disabled" : "active"
                    );
                    refresh();
                  }}
                >
                  <Prohibit size={16} />
                  {client.status === "active"
                    ? c("externalMcp.disable", "Disable")
                    : c("externalMcp.enable", "Enable")}
                </SoftButton>
              </div>
            </div>
          ))}
        </div>
      </SoftCard>
      <SoftCard title={c("externalMcp.grants", "Active grants")}>
        <div className="space-y-2">
          {config.grants.map((grant) => (
            <div
              key={grant.id}
              className="flex items-center justify-between rounded-xl border border-[var(--soft-border)] p-3 text-sm"
            >
              <span>
                {grant.subjectType} · {grant.tools.length} tools ·{" "}
                {grant.status} ·{" "}
                {new Date(grant.expiresAt).toLocaleDateString()}
              </span>
              {grant.status === "active" && (
                <button
                  className="text-red-500"
                  onClick={async () => {
                    await System.revokeExternalMcpGrant(grant.id);
                    refresh();
                  }}
                >
                  <Trash size={18} />
                </button>
              )}
            </div>
          ))}
        </div>
      </SoftCard>
      <SoftCard title={c("externalMcp.calls", "Recent calls")}>
        <div className="overflow-x-auto">
          <table className="settings-soft-table min-w-[620px] text-left text-xs">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Status</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {config.calls.map((call) => (
                <tr key={call.id}>
                  <td>{call.toolName}</td>
                  <td>{call.status}</td>
                  <td>{new Date(call.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SoftCard>
      <SoftButton
        variant="outline"
        onClick={async () => {
          if (
            await showAppConfirm({
              tone: "danger",
              title: c("externalMcp.emergency.title", "Revoke all MCP grants?"),
              description: c(
                "externalMcp.emergency.description",
                "All current third-party MCP access will stop within 30 seconds."
              ),
              confirmText: c("externalMcp.emergency.confirm", "Revoke all"),
            })
          ) {
            await System.emergencyRevokeExternalMcp();
            refresh();
          }
        }}
      >
        <Prohibit size={18} />
        {c("externalMcp.emergency.confirm", "Revoke all")}
      </SoftButton>
    </div>
  );
}

function LegacyRestApi() {
  const c = useCopy();
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState([]);
  const [revealed, setRevealed] = useState(null);
  async function refresh() {
    const Model = userFromStorage() ? Admin : System;
    const result = await Model.getApiKeys();
    setKeys(result.apiKeys || []);
    setLoading(false);
  }
  useEffect(() => {
    refresh();
  }, []);
  return (
    <SoftCard
      title={c("externalMcp.legacy.title", "Legacy REST API")}
      description={c(
        "externalMcp.legacy.description",
        "Existing keys continue to work. New broad-access keys can no longer be created; migrate integrations to Third-party MCP."
      )}
    >
      {revealed && (
        <div className="mb-4">
          <CopyValue value={revealed} />
        </div>
      )}
      {loading ? (
        <Skeleton.default height={160} />
      ) : (
        <div className="space-y-2">
          {keys.map((apiKey) => (
            <div
              key={apiKey.id}
              className="flex flex-col gap-3 rounded-xl border border-[var(--soft-border)] p-3 md:flex-row md:items-center"
            >
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {apiKey.name || c("api.row.unnamed", "Unnamed")}
                </p>
                <p className="font-mono text-xs text-theme-text-secondary">
                  {apiKey.secret}
                </p>
                <p className="text-xs text-theme-text-secondary">
                  {c("externalMcp.legacy.lastUsed", "Last used")}:{" "}
                  {apiKey.lastUsedAt
                    ? new Date(apiKey.lastUsedAt).toLocaleString()
                    : c("externalMcp.legacy.never", "Never")}
                </p>
              </div>
              <div className="flex gap-2">
                <SoftButton
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const Model = userFromStorage() ? Admin : System;
                    const result = await Model.rotateApiKey(apiKey.id);
                    if (result.apiKey) setRevealed(result.apiKey.secret);
                    refresh();
                  }}
                >
                  <ArrowsClockwise size={16} />
                  {c("externalMcp.rotate", "Rotate")}
                </SoftButton>
                <button
                  className="text-red-500"
                  onClick={async () => {
                    const Model = userFromStorage() ? Admin : System;
                    await Model.deleteApiKey(apiKey.id);
                    refresh();
                  }}
                >
                  <Trash size={18} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </SoftCard>
  );
}

export default function AdminApiKeys() {
  const c = useCopy();
  const [tab, setTab] = useState("mcp");
  return (
    <SoftSettingsLayout
      title={c("externalMcp.title", "Third-party MCP")}
      description={c(
        "externalMcp.description",
        "Allow approved agents to call a restricted, read-only Athena tool catalog through OAuth-protected MCP."
      )}
    >
      <div className="mb-4 flex gap-2 rounded-xl bg-[var(--soft-control)] p-1">
        <button
          type="button"
          onClick={() => setTab("mcp")}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold ${tab === "mcp" ? "bg-white text-[#2152ff] shadow-sm" : "text-theme-text-secondary"}`}
        >
          <Plug size={18} />
          {c("externalMcp.tabs.mcp", "Third-party MCP")}
        </button>
        <button
          type="button"
          onClick={() => setTab("legacy")}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold ${tab === "legacy" ? "bg-white text-[#2152ff] shadow-sm" : "text-theme-text-secondary"}`}
        >
          <Key size={18} />
          {c("externalMcp.tabs.legacy", "Legacy REST API")}
        </button>
      </div>
      {tab === "mcp" ? <ThirdPartyMcp /> : <LegacyRestApi />}
    </SoftSettingsLayout>
  );
}
