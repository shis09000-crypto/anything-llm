const { lazyDataAccessFacade } = require("../../../../dataAccess/lazyFacade");
const User = lazyDataAccessFacade("user");
const ToolInvocation = lazyDataAccessFacade("toolInvocation");
const {
  accountCryptoHubRegistry,
  cryptoAccountEligibility,
  resolveApprovedConnection,
} = require("../../../../cryptoAccount");
const {
  emitSemanticEvent,
} = require("../../../../observability/semanticEvents");
const { metrics } = require("../../../../observability/metrics");
const {
  cryptoAccountToolBrokerEnabled,
  invokeCryptoAccountTool,
} = require("../../../../toolRuntime/remoteClient");

const SKILL_NAME = "crypto-account-agent";
const RESULT_POLICY = "account-private/summary-only";
const APPROVAL_CLASS = "account-private-read";

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function symbolValue(value) {
  const symbol = String(value || "")
    .trim()
    .toUpperCase();
  if (!symbol) return null;
  if (!/^[A-Z0-9]{2,20}(?:[_/-][A-Z0-9]{2,12})?$/.test(symbol)) {
    const error = new Error("crypto_account_symbol_invalid");
    error.code = "crypto_account_symbol_invalid";
    throw error;
  }
  return symbol;
}

function approvalPayload(scope, input = {}, environment = "production") {
  return {
    approvalClass: APPROVAL_CLASS,
    scope,
    exchange: "gate",
    environment,
    ...(input.symbol ? { symbol: symbolValue(input.symbol) } : {}),
    ...(input.days ? { days: boundedInteger(input.days, 7, 1, 90) } : {}),
    ...(input.limit ? { limit: boundedInteger(input.limit, 10, 1, 100) } : {}),
  };
}

function eventFor(
  aibitat,
  eventType,
  { toolName, outcome, reasonCode = null, durationMs = null } = {}
) {
  if (eventType === "approval_requested") {
    metrics.cryptoAccountApprovals.inc({ outcome: "requested" });
  } else if (eventType === "approval_resolved") {
    metrics.cryptoAccountApprovals.inc({
      outcome: ["approved", "denied", "timeout", "failed"].includes(outcome)
        ? outcome
        : "failed",
    });
  }
  if (eventType.startsWith("crypto.account.read.")) {
    metrics.cryptoAccountReads.inc({
      function: toolName,
      outcome: outcome || "observed",
    });
    if (durationMs !== null) {
      metrics.cryptoAccountReadDuration.observe(
        {
          function: toolName,
          outcome: outcome || "observed",
        },
        Math.max(0, Number(durationMs) || 0) / 1_000
      );
    }
  }
  emitSemanticEvent({
    eventType,
    category: "crypto-account-access",
    severity: outcome === "failed" ? "error" : "info",
    outcome: outcome || "observed",
    subject: {
      type: "tool",
      component: "crypto-account-access",
      operation: toolName,
    },
    correlation: {
      invocationId: aibitat.handlerProps?.invocation?.uuid,
      clientTurnId: aibitat.handlerProps?.invocation?.clientTurnId,
    },
    stateTransition: reasonCode ? { reasonCode } : undefined,
    metadata: {
      ...(durationMs !== null ? { durationMs: String(durationMs) } : {}),
    },
    sensitivity: "metadata_only",
  });
}

async function sessionUser(aibitat) {
  const userId = Number(aibitat.handlerProps?.invocation?.user_id);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    const error = new Error("crypto_account_owner_unavailable");
    error.code = "crypto_account_owner_unavailable";
    throw error;
  }
  const user = await User.get({ id: userId });
  if (!user) {
    const error = new Error("crypto_account_owner_unavailable");
    error.code = "crypto_account_owner_unavailable";
    throw error;
  }
  return user;
}

function createAccountTool({ name, description, parameters, scope, execute }) {
  return {
    name,
    description,
    startupConfig: { params: {} },
    resultPolicy: RESULT_POLICY,
    plugin: function () {
      return {
        name,
        setup(aibitat) {
          aibitat.function({
            super: aibitat,
            name,
            description,
            resultPolicy: RESULT_POLICY,
            parameters: {
              $schema: "http://json-schema.org/draft-07/schema#",
              ...parameters,
            },
            handler: async function (input = {}) {
              const startedAt = Date.now();
              let readStartedAt = null;
              let phase = "eligibility";
              let approvalRequestId = null;
              try {
                const user = await sessionUser(this.super);
                const eligibility = await cryptoAccountEligibility(user);
                if (!eligibility.available) {
                  eventFor(this.super, "crypto.account.read.denied", {
                    toolName: name,
                    outcome: "denied",
                    reasonCode: eligibility.reason,
                  });
                  return JSON.stringify({
                    success: false,
                    error: eligibility.reason || "crypto_account_unavailable",
                  });
                }
                if (typeof this.super.requestToolApproval !== "function") {
                  eventFor(this.super, "crypto.account.read.denied", {
                    toolName: name,
                    outcome: "denied",
                    reasonCode: "approval_unavailable",
                  });
                  return JSON.stringify({
                    success: false,
                    error: "crypto_account_approval_unavailable",
                  });
                }
                const payload = approvalPayload(
                  scope,
                  input,
                  eligibility.environment
                );
                phase = "approval";
                eventFor(this.super, "approval_requested", {
                  toolName: name,
                  outcome: "requested",
                });
                const approval = await this.super.requestToolApproval({
                  skillName: name,
                  payload,
                  description: `读取 Gate 加密账户的${scope}信息`,
                  forceApproval: true,
                  allowAlwaysAllow: false,
                  approvalClass: APPROVAL_CLASS,
                });
                eventFor(this.super, "approval_resolved", {
                  toolName: name,
                  outcome: approval.approved ? "approved" : "denied",
                  reasonCode: approval.approved ? null : "approval_denied",
                });
                if (!approval.approved) {
                  eventFor(this.super, "crypto.account.read.denied", {
                    toolName: name,
                    outcome: "denied",
                    reasonCode: "approval_denied",
                  });
                  return JSON.stringify({
                    success: false,
                    error: "crypto_account_approval_denied",
                  });
                }
                approvalRequestId = String(approval.requestId || "").trim();
                if (!approvalRequestId) {
                  const error = new Error(
                    "crypto_account_approval_binding_missing"
                  );
                  error.code = "crypto_account_approval_binding_missing";
                  throw error;
                }

                const agentInvocationId =
                  this.super.handlerProps?.invocation?.uuid;
                phase = "capability";
                await ToolInvocation.startExecution({
                  approvalRequestId,
                  agentInvocationId,
                  toolName: name,
                  scope: payload,
                  args: input,
                });

                phase = "resolve";
                phase = "read";
                readStartedAt = Date.now();
                eventFor(this.super, "crypto.account.read.started", {
                  toolName: name,
                  outcome: "started",
                });
                const result = cryptoAccountToolBrokerEnabled()
                  ? await invokeCryptoAccountTool({
                      approvalRequestId,
                      toolName: name,
                      args: input,
                    })
                  : await (async () => {
                      const resolved = await resolveApprovedConnection({
                        user,
                        expectedCredentialVersion:
                          eligibility.credentialVersion,
                        expectedRootKeyId: eligibility.rootKeyId,
                        expectedDomainKeyVersion: eligibility.domainKeyVersion,
                      });
                      return execute(
                        accountCryptoHubRegistry.get(resolved),
                        input
                      );
                    })();
                const completed = await ToolInvocation.completeExecution({
                  approvalRequestId,
                  result,
                });
                if (!completed) {
                  const error = new Error(
                    "crypto_account_invocation_completion_failed"
                  );
                  error.code = "crypto_account_invocation_completion_failed";
                  throw error;
                }
                eventFor(this.super, "crypto.account.read.completed", {
                  toolName: name,
                  outcome: "completed",
                  durationMs: Date.now() - readStartedAt,
                });
                return JSON.stringify({
                  ...result,
                  latency_ms: Date.now() - startedAt,
                });
              } catch (error) {
                const reasonCode =
                  error?.code || error?.message || "crypto_account_read_failed";
                if (approvalRequestId) {
                  await ToolInvocation.failExecution({
                    approvalRequestId,
                    reasonCode,
                  }).catch(() => false);
                }
                if (phase === "approval") {
                  eventFor(this.super, "approval_resolved", {
                    toolName: name,
                    outcome: String(reasonCode)
                      .toLowerCase()
                      .includes("timeout")
                      ? "timeout"
                      : "failed",
                    reasonCode,
                  });
                }
                eventFor(
                  this.super,
                  phase === "read"
                    ? "crypto.account.read.failed"
                    : "crypto.account.read.denied",
                  {
                    toolName: name,
                    outcome: phase === "read" ? "failed" : "denied",
                    reasonCode,
                    durationMs:
                      phase === "read" && readStartedAt !== null
                        ? Date.now() - readStartedAt
                        : Date.now() - startedAt,
                  }
                );
                this.super.handlerProps?.log?.(
                  `[${name}] ${String(reasonCode).slice(0, 120)}`
                );
                return JSON.stringify({
                  success: false,
                  error: String(reasonCode).slice(0, 160),
                  latency_ms: Date.now() - startedAt,
                });
              }
            },
          });
        },
      };
    },
  };
}

const cryptoAccountOverview = createAccountTool({
  name: "crypto_account_overview",
  description:
    "Read the current user's private Gate account overview, equity, spot-versus-Earn allocation, and futures position summary. Holdings explicitly separate spotAmount and earnAmount; totalAmount is their sum and must never be described as spot-only. For cross-margin positions, configuredLeverage is not effective portfolio leverage, per-position pnlPct can be unavailable, and liquidation prices are reference-only. This is read-only and requires approval for every interactive call.",
  scope: "账户概览",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  execute: (hub) => hub.toolOverview(),
});

const cryptoAccountHoldings = createAccountTool({
  name: "crypto_account_holdings",
  description:
    "Read the current user's Gate spot and Earn holdings with public-market valuation. Every item separates spotAmount, earnAmount, and totalAmount; totalAmount is combined and must not be labeled as spot holdings. Optional symbol returns one asset. Read-only; approval is mandatory.",
  scope: "现货与理财资产",
  parameters: {
    type: "object",
    properties: {
      symbol: {
        type: "string",
        description: "Optional asset or pair, for example BTC or BTC_USDT.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        default: 10,
      },
    },
    additionalProperties: false,
  },
  execute: (hub, input) =>
    hub.holdings({
      symbol: symbolValue(input.symbol),
      limit: boundedInteger(input.limit, 10, 1, 20),
    }),
});

const cryptoAccountPositions = createAccountTool({
  name: "crypto_account_positions",
  description:
    "Read the current user's Gate futures positions and Gate account-level margin fields. For cross margin, configuredLeverage is not effective portfolio leverage, per-position return percentage is unavailable, position margins are not additive, and liquidation price is reference-only; do not infer liquidation safety. Optional symbol filters one contract. Read-only; approval is mandatory.",
  scope: "合约持仓与风险",
  parameters: {
    type: "object",
    properties: {
      symbol: {
        type: "string",
        description: "Optional asset or contract, for example BTC_USDT.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        default: 50,
      },
    },
    additionalProperties: false,
  },
  execute: (hub, input) =>
    hub.toolOpenPositions({
      symbol: symbolValue(input.symbol),
      limit: boundedInteger(input.limit, 50, 1, 50),
    }),
});

const cryptoAccountActivity = createAccountTool({
  name: "crypto_account_activity",
  description:
    "Read the current user's Gate trade activity and fee summary. Defaults to 7 days, maximum 90 days, with cursor pagination. Read-only; approval is mandatory.",
  scope: "交易记录与手续费",
  parameters: {
    type: "object",
    properties: {
      symbol: {
        type: "string",
        description: "Optional asset or contract filter.",
      },
      days: {
        type: "integer",
        minimum: 1,
        maximum: 90,
        default: 7,
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 50,
      },
      cursor: {
        type: "string",
        description: "Opaque timestamp cursor returned by a previous page.",
      },
    },
    additionalProperties: false,
  },
  execute: (hub, input) =>
    hub.activity({
      symbol: symbolValue(input.symbol),
      days: boundedInteger(input.days, 7, 1, 90),
      limit: boundedInteger(input.limit, 50, 1, 100),
      cursor: input.cursor || null,
    }),
});

const cryptoPortfolioOverview = createAccountTool({
  name: "crypto_portfolio_overview",
  description:
    "Read the current user's consolidated crypto portfolio. It keeps Gate as the authoritative real-account source and separately identifies user-supplied supplemental holdings that affect only the current portfolio, never Gate P&L, history, fees, or trades. The response includes an item-total conservation check, timestamps, and source policy. Read-only; approval is mandatory.",
  scope: "合并资产概览",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  execute: (hub) => hub.toolPortfolioOverview(),
});

const cryptoPortfolioRisk = createAccountTool({
  name: "crypto_portfolio_risk",
  description:
    "Read deterministic portfolio risk metrics and rule-based alerts for concentration, Gate account margin pressure, reference-only liquidation distance, drawdown, and data freshness. Cross-margin liquidation prices and configured leverage must never be described as a guarantee of account safety. Read-only; approval is mandatory.",
  scope: "资产风险概览",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  execute: (hub) => hub.toolPortfolioRisk(),
});

const cryptoAccountAgent = {
  name: SKILL_NAME,
  conditional: true,
  approvalRequired: true,
  startupConfig: { params: {} },
  plugin: [
    cryptoAccountOverview,
    cryptoAccountHoldings,
    cryptoAccountPositions,
    cryptoAccountActivity,
    cryptoPortfolioOverview,
    cryptoPortfolioRisk,
  ],
};

module.exports = {
  APPROVAL_CLASS,
  RESULT_POLICY,
  SKILL_NAME,
  cryptoAccountAgent,
  cryptoAccountActivity,
  cryptoAccountHoldings,
  cryptoAccountOverview,
  cryptoAccountPositions,
  cryptoPortfolioOverview,
  cryptoPortfolioRisk,
};
