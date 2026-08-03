import useLogo from "@/hooks/useLogo";
import System from "@/models/system";

export default function AuthBootstrapError({
  message = "认证配置暂时不可用，请检查网络连接后重试。",
} = {}) {
  const { loginLogo, isCustomLogo } = useLogo();
  return (
    <div className="fixed inset-0 bg-zinc-950 light:bg-slate-50 flex flex-col items-center justify-center overflow-hidden px-6 text-center">
      <img
        src={loginLogo}
        alt="Logo"
        className={`mb-6 max-h-[72px] ${isCustomLogo ? "rounded-lg" : ""}`}
        style={{ objectFit: "contain" }}
      />
      <div className="max-w-md rounded-xl border border-white/10 bg-white/5 p-6 shadow-2xl light:border-slate-200 light:bg-white">
        <h1 className="text-lg font-semibold text-white light:text-slate-900">
          登录服务暂时不可用
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-300 light:text-slate-600">
          {message}
        </p>
        <p className="mt-2 text-xs leading-5 text-slate-400 light:text-slate-500">
          系统会自动恢复；已有登录状态和本地可信数据不会被清除。
        </p>
        <button
          type="button"
          onClick={() => {
            System.clearAuthBootstrapCache();
            window.dispatchEvent(new Event("athena-auth-bootstrap-retry"));
          }}
          className="mt-5 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-slate-200 light:bg-slate-900 light:text-white light:hover:bg-slate-700"
        >
          立即重试
        </button>
      </div>
    </div>
  );
}
