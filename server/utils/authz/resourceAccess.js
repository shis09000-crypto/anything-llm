const crypto = require("crypto");
const { AuthIdentity } = require("../../models/authIdentity");
const { SystemSettings } = require("../../models/systemSettings");
const { User } = require("../../models/user");
const { Workspace } = require("../../models/workspace");
const {
  WorkspaceAgentInvocation,
} = require("../../models/workspaceAgentInvocation");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { WorkspaceParsedFiles } = require("../../models/workspaceParsedFiles");
const { WorkspaceThread } = require("../../models/workspaceThread");
const {
  codexDevAuthUser,
  isCodexDevAuthBypassEnabled,
} = require("../codexDevAuthBypass");
const { decodeJWT } = require("../http");
const { jwtIdleState } = require("../sessionIdle");

const FILE_OWNER_SCOPE_VERSION = 1;

function resourceIdHash(resourceId = null) {
  if (resourceId === null || resourceId === undefined) return null;
  return crypto
    .createHash("sha256")
    .update(String(resourceId))
    .digest("hex")
    .slice(0, 16);
}

function recordResourceAccessAudit({
  resourceType,
  resourceId = null,
  userId = null,
  result,
  reason = null,
} = {}) {
  if (process.env.ATHENA_RESOURCE_ACCESS_DEBUG !== "1") return;
  console.debug("[resource-access]", {
    resourceType,
    resourceIdHash: resourceIdHash(resourceId),
    userId,
    result,
    reason,
  });
}

function bearerToken(request, explicitToken = null) {
  if (explicitToken) return String(explicitToken);
  const queryToken = request?.query?.token;
  if (queryToken) return decodeURIComponent(String(queryToken));
  const auth =
    request?.header?.("Authorization") || request?.headers?.authorization;
  return auth ? String(auth).replace(/^Bearer\s+/i, "") : null;
}

async function userFromBearerToken(
  token = null,
  { requireAuthIdentity = true } = {}
) {
  if (!token) return null;
  const valid = decodeJWT(token);
  if (!valid?.id) return null;
  const idleState = jwtIdleState(valid);
  if (idleState.idleExpired) return null;

  const shadow = User._get
    ? await User._get({ id: valid.id })
    : await User.get({ id: valid.id });
  if (!shadow) return null;
  if (!requireAuthIdentity) {
    return User.filterFields ? User.filterFields(shadow) : shadow;
  }

  let authUser = valid.authUserId
    ? await AuthIdentity.findById(valid.authUserId)
    : null;
  if (!authUser && shadow.authUserId) {
    authUser = await AuthIdentity.findById(shadow.authUserId);
  }
  if (!authUser) {
    authUser = await AuthIdentity.bootstrapAuthUserFromShadow(shadow);
  }
  if (!authUser || !(await AuthIdentity.canLoginInCurrentEnvAsync(authUser))) {
    return null;
  }

  const syncedUser = await AuthIdentity.ensureShadowUser(authUser);
  return User.filterFields ? User.filterFields(syncedUser) : syncedUser;
}

async function requestAuthContext({
  request,
  response = null,
  token = null,
} = {}) {
  if (isCodexDevAuthBypassEnabled(request)) {
    return {
      multiUser: false,
      user: codexDevAuthUser(),
      authenticated: true,
    };
  }

  const multiUser =
    response?.locals?.multiUserMode ?? (await SystemSettings.isMultiUserMode());
  const tokenValue = bearerToken(request, token);
  const user =
    response?.locals?.user ||
    (await userFromBearerToken(tokenValue, {
      requireAuthIdentity: multiUser,
    }));
  if (!multiUser) {
    return { multiUser: false, user, authenticated: true };
  }

  return {
    multiUser: true,
    user,
    authenticated: !!user,
  };
}

function fileBackedOwnerMetadata(user = null) {
  return {
    ownerScopeVersion: FILE_OWNER_SCOPE_VERSION,
    ownerUserId: user?.id ?? null,
    ownerAuthUserId: user?.authUserId ?? null,
  };
}

function stripFileBackedOwnerMetadata(metadata = {}) {
  const {
    ownerScopeVersion: _ownerScopeVersion,
    ownerUserId: _ownerUserId,
    ownerAuthUserId: _ownerAuthUserId,
    ...publicMetadata
  } = metadata || {};
  return publicMetadata;
}

async function getAuthorizedFileBackedResource({
  request,
  response = null,
  token = null,
  metadata = null,
  resourceType,
  resourceId = null,
} = {}) {
  const auth = await requestAuthContext({ request, response, token });
  const ownerUserId =
    metadata && Object.prototype.hasOwnProperty.call(metadata, "ownerUserId")
      ? metadata.ownerUserId
      : undefined;
  let allowed = false;
  let reason = null;

  if (auth.multiUser && !auth.authenticated) {
    reason = "unauthenticated";
  } else if (ownerUserId === undefined) {
    allowed = !auth.multiUser;
    reason = allowed
      ? "legacy_ownerless_single_user"
      : "legacy_ownerless_multi_user";
  } else if (ownerUserId === null || ownerUserId === "") {
    allowed = !auth.multiUser;
    reason = allowed ? "ownerless_single_user" : "ownerless_multi_user";
  } else {
    allowed =
      !auth.multiUser ||
      (auth.user?.id && Number(ownerUserId) === Number(auth.user.id));
    reason = allowed ? null : "not_found_or_not_owned";
  }

  recordResourceAccessAudit({
    resourceType,
    resourceId,
    userId: auth.user?.id || null,
    result: allowed ? "allowed" : "denied",
    reason,
  });

  return allowed ? { auth, user: auth.user || null } : null;
}

function workspaceClause({ workspaceId = null, workspaceSlug = null } = {}) {
  if (workspaceSlug) return { slug: String(workspaceSlug) };
  if (workspaceId) return { id: Number(workspaceId) };
  return null;
}

async function getAuthorizedWorkspace({
  request,
  response = null,
  workspaceId = null,
  workspaceSlug = null,
  token = null,
} = {}) {
  const clause = workspaceClause({ workspaceId, workspaceSlug });
  const auth = await requestAuthContext({ request, response, token });
  if (!clause) {
    recordResourceAccessAudit({
      resourceType: "workspace",
      userId: auth.user?.id || null,
      result: "denied",
      reason: "missing_workspace_identifier",
    });
    return null;
  }
  if (auth.multiUser && !auth.authenticated) {
    recordResourceAccessAudit({
      resourceType: "workspace",
      resourceId: workspaceId || workspaceSlug,
      result: "denied",
      reason: "unauthenticated",
    });
    return null;
  }

  const workspace = auth.multiUser
    ? await Workspace.getWithUser(auth.user, clause)
    : await Workspace.get(clause);
  recordResourceAccessAudit({
    resourceType: "workspace",
    resourceId: workspace?.id || workspaceId || workspaceSlug,
    userId: auth.user?.id || null,
    result: workspace ? "allowed" : "denied",
    reason: workspace ? null : "not_found_or_not_owned",
  });
  return workspace || null;
}

async function getAuthorizedWorkspaceThread({
  request,
  response = null,
  workspaceId = null,
  workspaceSlug = null,
  threadSlug = null,
  token = null,
} = {}) {
  const workspace = await getAuthorizedWorkspace({
    request,
    response,
    workspaceId,
    workspaceSlug,
    token,
  });
  if (!workspace || !threadSlug) return { workspace, thread: null };
  const auth = await requestAuthContext({ request, response, token });
  if (auth.multiUser && !auth.authenticated)
    return { workspace: null, thread: null };

  const threadClause = {
    slug: String(threadSlug),
    workspace_id: workspace.id,
  };
  let thread = await WorkspaceThread.get({
    ...threadClause,
    ...(auth.user?.id ? { user_id: auth.user.id } : {}),
  });
  if (!thread && !auth.multiUser && auth.user?.id) {
    thread = await WorkspaceThread.get(threadClause);
  }
  recordResourceAccessAudit({
    resourceType: "thread",
    resourceId: thread?.id || threadSlug,
    userId: auth.user?.id || null,
    result: thread ? "allowed" : "denied",
    reason: thread ? null : "not_found_or_not_owned",
  });
  return { workspace, thread: thread || null };
}

function scopedWorkspaceChatClause({
  chatId,
  workspaceId,
  threadId,
  userId,
  include,
  apiSessionId,
} = {}) {
  if (!chatId || !workspaceId) return null;
  const clause = {
    id: Number(chatId),
    workspaceId: Number(workspaceId),
  };
  if (threadId !== undefined)
    clause.thread_id = threadId === null ? null : Number(threadId);
  if (userId !== undefined)
    clause.user_id = userId === null ? null : Number(userId);
  if (include !== undefined) clause.include = include;
  if (apiSessionId !== undefined)
    clause.api_session_id = apiSessionId === null ? null : String(apiSessionId);
  return clause;
}

async function getScopedWorkspaceChat({
  chatId,
  workspaceId,
  threadId,
  userId,
  include,
  apiSessionId,
} = {}) {
  const clause = scopedWorkspaceChatClause({
    chatId,
    workspaceId,
    threadId,
    userId,
    include,
    apiSessionId,
  });
  if (!clause) return null;
  const chat = await WorkspaceChats.get(clause);
  recordResourceAccessAudit({
    resourceType: "workspace_chat",
    resourceId: chatId,
    userId,
    result: chat ? "allowed" : "denied",
    reason: chat ? null : "not_found_or_not_owned",
  });
  return chat || null;
}

async function getAuthorizedWorkspaceChat({
  request,
  response = null,
  workspaceId = null,
  workspaceSlug = null,
  chatId,
  threadId,
  include,
  apiSessionId,
  token = null,
} = {}) {
  const workspace = await getAuthorizedWorkspace({
    request,
    response,
    workspaceId,
    workspaceSlug,
    token,
  });
  if (!workspace || !chatId) return { workspace, chat: null };

  const auth = await requestAuthContext({ request, response, token });
  if (auth.multiUser && !auth.authenticated)
    return { workspace: null, chat: null };

  const userId =
    auth.multiUser || auth.user?.id ? auth.user?.id || null : undefined;
  let chat = await getScopedWorkspaceChat({
    chatId,
    workspaceId: workspace.id,
    threadId,
    userId,
    include,
    apiSessionId,
  });
  if (!chat && !auth.multiUser && auth.user?.id) {
    chat = await getScopedWorkspaceChat({
      chatId,
      workspaceId: workspace.id,
      threadId,
      include,
      apiSessionId,
    });
  }

  return { workspace, chat: chat || null };
}

async function getAuthorizedParsedFile({
  request,
  response = null,
  workspace,
  fileId,
  token = null,
} = {}) {
  if (!workspace || !fileId) return null;
  const auth = await requestAuthContext({ request, response, token });
  if (auth.multiUser && !auth.authenticated) return null;
  const parsedFileClause = {
    id: parseInt(fileId),
    workspaceId: workspace.id,
  };
  let parsedFile = await WorkspaceParsedFiles.get({
    ...parsedFileClause,
    ...(auth.user ? { userId: auth.user.id } : {}),
  });
  if (!parsedFile && !auth.multiUser && auth.user?.id) {
    parsedFile = await WorkspaceParsedFiles.get(parsedFileClause);
  }
  recordResourceAccessAudit({
    resourceType: "parsed_file",
    resourceId: fileId,
    userId: auth.user?.id || null,
    result: parsedFile ? "allowed" : "denied",
    reason: parsedFile ? null : "not_found_or_not_owned",
  });
  return parsedFile || null;
}

async function getAuthorizedAgentInvocation({
  request,
  response = null,
  uuid,
  token = null,
} = {}) {
  if (!uuid) return null;
  const invocation = await WorkspaceAgentInvocation.get({ uuid: String(uuid) });
  if (!invocation) {
    recordResourceAccessAudit({
      resourceType: "agent_invocation",
      resourceId: uuid,
      result: "denied",
      reason: "not_found",
    });
    return null;
  }

  const auth = await requestAuthContext({ request, response, token });
  if (auth.multiUser && !auth.authenticated) return null;
  const workspace = await getAuthorizedWorkspace({
    request,
    response,
    workspaceId: invocation.workspace_id,
    token,
  });
  const ownsInvocation =
    !auth.multiUser ||
    (auth.user?.id && Number(invocation.user_id) === Number(auth.user.id));
  const allowed = !!workspace && ownsInvocation;
  recordResourceAccessAudit({
    resourceType: "agent_invocation",
    resourceId: uuid,
    userId: auth.user?.id || null,
    result: allowed ? "allowed" : "denied",
    reason: allowed ? null : "not_found_or_not_owned",
  });
  return allowed ? { invocation, workspace, user: auth.user || null } : null;
}

module.exports = {
  fileBackedOwnerMetadata,
  getAuthorizedAgentInvocation,
  getAuthorizedFileBackedResource,
  getAuthorizedParsedFile,
  getAuthorizedWorkspace,
  getAuthorizedWorkspaceChat,
  getAuthorizedWorkspaceThread,
  getScopedWorkspaceChat,
  recordResourceAccessAudit,
  requestAuthContext,
  stripFileBackedOwnerMetadata,
};
