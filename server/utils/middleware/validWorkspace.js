const {
  getAuthorizedWorkspace,
  getAuthorizedWorkspaceThread,
} = require("../authz/resourceAccess");

// Will pre-validate and set the workspace for a request if the slug is provided in the URL path.
async function validWorkspaceSlug(request, response, next) {
  const { slug } = request.params;
  const workspace = await getAuthorizedWorkspace({
    request,
    response,
    workspaceSlug: slug,
  });

  if (!workspace) {
    response.status(404).send("Workspace does not exist.");
    return;
  }

  response.locals.workspace = workspace;
  next();
}

// Will pre-validate and set the workspace AND a thread for a request if the slugs are provided in the URL path.
async function validWorkspaceAndThreadSlug(request, response, next) {
  const { slug, threadSlug } = request.params;
  const { workspace, thread } = await getAuthorizedWorkspaceThread({
    request,
    response,
    workspaceSlug: slug,
    threadSlug,
  });

  if (!workspace) {
    response.status(404).send("Workspace does not exist.");
    return;
  }

  if (!thread) {
    response.status(404).send("Workspace thread does not exist.");
    return;
  }

  response.locals.workspace = workspace;
  response.locals.thread = thread;
  next();
}

module.exports = {
  validWorkspaceSlug,
  validWorkspaceAndThreadSlug,
};
