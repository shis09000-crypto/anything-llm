import { useEffect, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import * as Skeleton from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";
import Admin from "@/models/admin";
import UserRow from "./UserRow";
import useUser from "@/hooks/useUser";
import Toggle from "@/components/lib/Toggle";
import { useTranslation } from "react-i18next";
import { normalizeRole } from "@/utils/authz";

export default function AdminUsers() {
  const { t } = useTranslation();

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:py-6 py-16">
          <div className="w-full flex flex-col gap-y-1 pb-6 border-white/10 border-b-2">
            <div className="items-center flex gap-x-4">
              <p className="text-lg leading-6 font-bold text-theme-text-primary">
                {t("admin.users.title")}
              </p>
            </div>
            <p className="text-xs leading-[18px] font-base text-theme-text-secondary">
              {t("admin.users.description")}
            </p>
          </div>
          <div className="overflow-x-auto mt-6">
            <UsersContainer />
          </div>
        </div>
      </div>
    </div>
  );
}

function UsersContainer() {
  const { t } = useTranslation();
  const { user: currUser } = useUser();
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);

  useEffect(() => {
    async function fetchUsers() {
      const _users = await Admin.users();
      setUsers(_users);
      setLoading(false);
    }
    fetchUsers();
  }, []);

  if (loading) {
    return (
      <Skeleton.default
        height="80vh"
        width="100%"
        highlightColor="var(--theme-bg-primary)"
        baseColor="var(--theme-bg-secondary)"
        count={1}
        className="w-full p-4 rounded-b-2xl rounded-tr-2xl rounded-tl-sm mt-8"
        containerClassName="flex w-full"
      />
    );
  }

  return (
    <table className="w-full text-xs text-left rounded-lg min-w-[640px] border-spacing-0">
      <thead className="text-theme-text-secondary text-xs leading-[18px] font-bold uppercase border-white/10 border-b">
        <tr>
          <th scope="col" className="px-6 py-3 rounded-tl-lg">
            {t("admin.users.table.username")}
          </th>
          <th scope="col" className="px-6 py-3">
            {t("admin.users.table.role")}
          </th>
          <th scope="col" className="px-6 py-3">
            {t("admin.users.table.dateAdded")}
          </th>
          <th scope="col" className="px-6 py-3 rounded-tr-lg">
            {" "}
          </th>
        </tr>
      </thead>
      <tbody>
        {users.map((user) => (
          <UserRow key={user.id} currUser={currUser} user={user} />
        ))}
      </tbody>
    </table>
  );
}

export function RoleHintDisplay({ role }) {
  const { t } = useTranslation();
  const ROLE_HINT = {
    user: [
      t("admin.users.permissions.default.0"),
      t("admin.users.permissions.default.1"),
    ],
    developer: [
      t("admin.users.permissions.developer.0", {
        defaultValue: "Can sign in to development only.",
      }),
      t("admin.users.permissions.developer.1", {
        defaultValue: "Can test experimental features.",
      }),
    ],
    admin: [
      t("admin.users.permissions.adminScoped.0", {
        defaultValue:
          "Can access the admin dashboard and manage users, workspaces, invites, and system settings.",
      }),
      t("admin.users.permissions.adminScoped.1", {
        defaultValue: "Can sign in to production and development.",
      }),
    ],
    owner: [
      t("admin.users.permissions.owner.0", {
        defaultValue: "Highest permission level.",
      }),
      t("admin.users.permissions.owner.1", {
        defaultValue:
          "Can manage admins, security policy, audit logs, and global configuration.",
      }),
    ],
  };
  const normalizedRole = normalizeRole(role);

  return (
    <div className="flex flex-col gap-y-1 py-1 pb-4">
      <p className="text-sm font-medium text-theme-text-primary">
        {t("admin.users.permissions.title")}
      </p>
      <ul className="flex flex-col gap-y-1 list-disc px-4">
        {(ROLE_HINT[normalizedRole] ?? ROLE_HINT.user).map((hints, i) => {
          return (
            <li key={i} className="text-xs text-theme-text-secondary">
              {hints}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function MessageLimitInput({ enabled, limit, updateState, role }) {
  const { t } = useTranslation();
  if (["admin", "owner"].includes(normalizeRole(role))) return null;

  return (
    <div className="mt-4 mb-8">
      <Toggle
        size="md"
        variant="horizontal"
        label={t("admin.users.messageLimit.label")}
        description={t("admin.users.messageLimit.description")}
        enabled={enabled}
        onChange={(checked) => {
          updateState((prev) => ({
            ...prev,
            enabled: checked,
          }));
        }}
      />
      {enabled && (
        <div className="mt-4">
          <label className="text-white text-sm font-semibold block mb-4">
            {t("admin.users.messageLimit.inputLabel")}
          </label>
          <div className="relative mt-2">
            <input
              type="number"
              onScroll={(e) => e.target.blur()}
              onChange={(e) => {
                updateState({
                  enabled: true,
                  limit: Number(e?.target?.value || 0),
                });
              }}
              value={limit}
              min={1}
              className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
            />
          </div>
        </div>
      )}
    </div>
  );
}
