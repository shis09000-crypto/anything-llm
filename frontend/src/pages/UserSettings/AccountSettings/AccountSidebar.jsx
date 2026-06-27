import {
  ArrowLeft,
  Bell,
  BookOpen,
  ChatsCircle,
  DeviceMobile,
  EnvelopeSimple,
  Fingerprint,
  LockKey,
  MagnifyingGlass,
  Note,
  ShieldCheck,
  SignOut,
  Sparkle,
  TextT,
  UserCircle,
  UserCircleGear,
} from "@phosphor-icons/react";
import AppButton from "@/components/lib/AppButton";
import { canSeeAdmin } from "@/utils/authz";

const navItems = [
  { href: "#profile", label: "个人信息", icon: UserCircle },
  { href: "#personalization", label: "个性化设置", icon: Sparkle },
  { href: "#memory-blocks", label: "长期记忆", icon: Note },
  { href: "#contact", label: "联系方式", icon: EnvelopeSimple },
  { href: "#security", label: "登录与安全", icon: LockKey },
  { href: "#passkeys", label: "通行密钥", icon: Fingerprint },
  { href: "#sessions", label: "会话与设备", icon: DeviceMobile },
  { href: "#notifications", label: "邮箱与通知", icon: Bell },
  { href: "#privacy", label: "数据与隐私", icon: ShieldCheck },
];

const adminNavItems = [
  { href: "#admin", label: "概览", icon: UserCircleGear },
  { href: "#admin-users", label: "用户", icon: UserCircle },
  { href: "#admin-workspaces", label: "工作区", icon: BookOpen },
  { href: "#admin-chats", label: "对话历史记录", icon: ChatsCircle },
  { href: "#admin-invites", label: "邀请", icon: EnvelopeSimple },
  { href: "#admin-default-prompt", label: "默认系统提示词", icon: TextT },
];

function NavLink({ href, label, icon: Icon, active = false, onNavigate }) {
  return (
    <a
      key={href}
      href={href}
      onClick={(event) => {
        if (!onNavigate) return;
        event.preventDefault();
        onNavigate(href);
      }}
      className={[
        "flex items-center gap-3 rounded-2xl px-3 py-2.5 text-sm font-medium transition hover:bg-white hover:text-slate-950 hover:shadow-sm",
        active ? "bg-white text-slate-950 shadow-sm" : "text-slate-600",
      ].join(" ")}
    >
      <Icon className="h-5 w-5" />
      <span>{label}</span>
    </a>
  );
}

export default function AccountSidebar({
  user,
  activeHash = "#profile",
  onNavigateHash,
  onReturnHome,
  onSignOut,
}) {
  const showAdmin = canSeeAdmin(user);

  return (
    <aside className="account-settings-sidebar flex w-full flex-col border-r border-slate-200 bg-[#f5f5f7] px-4 py-5 md:w-[282px]">
      <div>
        <AppButton
          type="button"
          variant="secondary"
          size="sm"
          iconOnly
          aria-label="返回主界面"
          title="返回主界面"
          leftIcon={<ArrowLeft className="h-4 w-4" />}
          onClick={onReturnHome}
          className="mb-4"
        />
        <p className="px-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
          Account Settings
        </p>
        <div className="mt-4 flex h-10 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 shadow-sm">
          <MagnifyingGlass className="h-4 w-4 text-slate-400" />
          <input
            type="search"
            placeholder="搜索"
            className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400"
          />
        </div>
      </div>
      <nav className="mt-5 flex flex-1 flex-col gap-1 overflow-y-auto pb-2">
        {navItems.map(({ href, label, icon: Icon }) => (
          <NavLink
            key={href}
            href={href}
            label={label}
            icon={Icon}
            active={activeHash === href}
            onNavigate={onNavigateHash}
          />
        ))}
        {showAdmin && (
          <div className="mt-4 border-t border-slate-200 pt-4">
            <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
              管理员
            </p>
            <div className="flex flex-col gap-1">
              {adminNavItems.map(({ href, label, icon: Icon }) => (
                <NavLink
                  key={href}
                  href={href}
                  label={label}
                  icon={Icon}
                  active={activeHash === href}
                  onNavigate={onNavigateHash}
                />
              ))}
            </div>
          </div>
        )}
      </nav>
      <button
        type="button"
        onClick={onSignOut}
        className="mt-4 flex items-center gap-3 rounded-2xl px-3 py-2.5 text-sm font-semibold text-red-600 transition hover:bg-white hover:shadow-sm"
      >
        <SignOut className="h-5 w-5" />
        退出登录
      </button>
    </aside>
  );
}
