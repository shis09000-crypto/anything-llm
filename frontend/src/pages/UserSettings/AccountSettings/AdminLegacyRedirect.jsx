import { Navigate, useLocation } from "react-router-dom";

const LEGACY_ADMIN_HASHES = {
  "/settings/users": "admin-users",
  "/settings/workspaces": "admin-workspaces",
  "/settings/workspace-chats": "admin-chats",
  "/settings/invites": "admin-invites",
  "/settings/default-system-prompt": "admin-default-prompt",
};

export default function AdminLegacyRedirect() {
  const { pathname } = useLocation();
  const hash = LEGACY_ADMIN_HASHES[pathname] || "admin";
  return <Navigate replace to={`/settings/account#${hash}`} />;
}
