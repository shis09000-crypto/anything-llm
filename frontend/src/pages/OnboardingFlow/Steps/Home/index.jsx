import paths from "@/utils/paths";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import useRedirectToHomeOnOnboardingComplete from "@/hooks/useOnboardingComplete";
import AthenaLogo from "@/media/logo/athena-logo.svg";

const CAPABILITIES = [
  {
    title: "向量引擎",
    body: "将文档、知识与对话转化为可检索的语义向量，为搜索和推理提供基础。",
  },
  {
    title: "知识图谱",
    body: "组织文档、知识节点与上下文关系，让资料形成清晰的知识结构。",
  },
  {
    title: "语义检索",
    body: "从知识库中查找最相关的内容，让回答基于已有资料生成。",
  },
  {
    title: "智能执行",
    body: "提供面向任务的分析与执行能力，让知识能够被理解、调用和协作。",
  },
];

export default function OnboardingHome() {
  const navigate = useNavigate();
  useRedirectToHomeOnOnboardingComplete();
  const { t } = useTranslation();

  return (
    <div className="relative w-screen min-h-screen flex flex-col overflow-hidden bg-zinc-950 light:bg-slate-50">
      <div
        className="absolute inset-0 light:hidden"
        style={{
          background:
            "radial-gradient(ellipse 140% 90% at 50% 0%, rgba(129, 139, 154, 0.26) 0%, rgba(18, 25, 36, 0.1) 52%, transparent 88%)",
        }}
      />
      <div
        className="absolute inset-0 hidden light:block"
        style={{
          background:
            "radial-gradient(ellipse 140% 90% at 50% 0%, rgba(222, 210, 180, 0.5) 0%, rgba(248, 250, 252, 0.68) 52%, transparent 88%)",
        }}
      />

      <div className="relative z-10 flex justify-center pt-10 md:pt-[58px]">
        <p className="text-white/80 light:text-slate-700 text-2xl md:text-3xl font-semibold">
          {t("common.productName")}
        </p>
      </div>

      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-5 py-10 md:py-16">
        <img
          src={AthenaLogo}
          alt="Athena Logo"
          className="h-[168px] md:h-[232px] w-auto object-contain mb-8"
        />

        <div className="text-center max-w-[760px]">
          <p className="text-white light:text-slate-800 text-[54px] md:text-[88px] leading-none font-semibold">
            Athena
          </p>
          <h1 className="mt-4 text-white/85 light:text-slate-700 text-2xl md:text-4xl font-medium">
            知识。检索。智能。
          </h1>
          <p className="mt-5 text-white/58 light:text-slate-500 text-base md:text-lg leading-7 max-w-[660px] mx-auto">
            Athena 将文档、知识与对话组织为可检索、可推理的智能系统。
          </p>
          <p className="mt-3 text-[#D1B26A] text-sm md:text-base font-semibold">
            知识操作系统
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 w-full max-w-[980px] mt-10">
          {CAPABILITIES.map((capability) => (
            <div
              key={capability.title}
              className="border border-white/10 light:border-slate-200 bg-white/[0.04] light:bg-white rounded-lg px-4 py-4"
            >
              <p className="text-white light:text-slate-800 text-sm font-semibold">
                {capability.title}
              </p>
              <p className="text-white/52 light:text-slate-500 text-xs leading-5 mt-2">
                {capability.body}
              </p>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => navigate(paths.onboarding.llmPreference())}
          className="relative border-none z-10 h-[36px] w-[300px] py-2.5 px-5 rounded-lg bg-slate-50 hover:bg-slate-300 font-medium text-sm mt-[42px] text-zinc-900 light:text-white light:bg-slate-900 light:hover:bg-slate-800 text-center flex justify-center items-center motion-hover"
        >
          {t("onboarding.home.getStarted")}
        </button>
      </div>
    </div>
  );
}
