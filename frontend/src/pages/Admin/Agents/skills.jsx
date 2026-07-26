import AgentWebSearchSelection from "./WebSearchSelection";
import AgentSQLConnectorSelection from "./SQLConnectorSelection";
import GenericSkillPanel from "./GenericSkillPanel";
import DefaultSkillPanel from "./DefaultSkillPanel";
import FileSystemSkillPanel from "./FileSystemSkillPanel";
import CreateFileSkillPanel from "./CreateFileSkillPanel";
import GMailSkillPanel from "./GMailSkillPanel";
import GoogleCalendarSkillPanel from "./GoogleCalendarSkillPanel";
import OutlookSkillPanel from "./OutlookSkillPanel";
import MarketDataSkillPanel from "./MarketDataSkillPanel";
import {
  Brain,
  File,
  Browser,
  ChartBar,
  FolderOpen,
  FilePlus,
  Terminal,
  ListChecks,
  ChatCircleDots,
  CurrencyBtc,
  CloudSun,
  GlobeHemisphereWest,
  FileDoc,
} from "@phosphor-icons/react";
import RAGImage from "@/media/agents/rag-memory.png";
import SummarizeImage from "@/media/agents/view-summarize.png";
import ScrapeWebsitesImage from "@/media/agents/scrape-websites.png";
import GenerateChartsImage from "@/media/agents/generate-charts.png";
import GenerateSaveImages from "@/media/agents/generate-save-files.png";
import FileSystemImage from "@/media/agents/file-system.png";
import GMailIcon from "./GMailSkillPanel/gmail.png";
import OutlookIcon from "./OutlookSkillPanel/outlook.png";
import GoogleCalendarIcon from "./GoogleCalendarSkillPanel/google-calendar.png";

export const WEB_BROWSING_SKILL = "web-browsing";

export function isSearchModelConfigured(settings = {}) {
  return (
    settings?.SearchModelProvider === "alibaba" &&
    settings?.SearchModelApiKey === true &&
    Boolean(settings?.SearchModelBaseUrl) &&
    Boolean(settings?.SearchModelPref)
  );
}

export function configurableAgentSkillsFromSettings(agentSkills = []) {
  return (agentSkills || []).filter(
    (skill) => skill !== WEB_BROWSING_SKILL && skill !== "create-files-agent"
  );
}

export function isDefaultAgentSkillEnabled(
  skill,
  disabledAgentSkills = [],
  settings = {}
) {
  if (skill === WEB_BROWSING_SKILL)
    return (
      isSearchModelConfigured(settings) &&
      !disabledAgentSkills.includes(WEB_BROWSING_SKILL)
    );

  return !disabledAgentSkills.includes(skill);
}

export const getDefaultSkills = (
  t,
  { cryptoAccountAvailable = false } = {}
) => ({
  "create-files-agent": {
    title: t("agent.skill.createFiles.title"),
    description: t("agent.skill.createFiles.description"),
    component: CreateFileSkillPanel,
    skill: "create-files-agent",
    icon: FilePlus,
    image: GenerateSaveImages,
  },
  "document-formatting-agent": {
    title: t("agent.skill.documentFormatting.title"),
    description: t("agent.skill.documentFormatting.description"),
    component: DefaultSkillPanel,
    skill: "document-formatting-agent",
    icon: FileDoc,
    image: GenerateSaveImages,
  },
  "crypto-market-agent": {
    title: t("agent.skill.cryptoMarket.title"),
    description: t("agent.skill.cryptoMarket.description"),
    component: MarketDataSkillPanel,
    icon: CurrencyBtc,
    image: GenerateChartsImage,
    skill: "crypto-market-agent",
    configKind: "crypto",
  },
  ...(cryptoAccountAvailable && {
    "crypto-account-agent": {
      title: "加密账户信息",
      description:
        "读取当前账户绑定的 Gate 加密专区资产、持仓、活动和手续费。所有交互调用均需逐次批准。",
      component: DefaultSkillPanel,
      icon: CurrencyBtc,
      image: GenerateChartsImage,
      skill: "crypto-account-agent",
    },
  }),
  "weather-agent": {
    title: t("agent.skill.weather.title"),
    description: t("agent.skill.weather.description"),
    component: MarketDataSkillPanel,
    icon: CloudSun,
    image: ScrapeWebsitesImage,
    skill: "weather-agent",
    configKind: "weather",
  },
  "global-market-agent": {
    title: t("agent.skill.globalMarket.title"),
    description: t("agent.skill.globalMarket.description"),
    component: MarketDataSkillPanel,
    icon: GlobeHemisphereWest,
    image: GenerateChartsImage,
    skill: "global-market-agent",
    configKind: "global",
  },
  "rag-memory": {
    title: `Search: ${t("agent.skill.rag.title")}`,
    description: t("agent.skill.rag.description"),
    component: DefaultSkillPanel,
    icon: Brain,
    image: RAGImage,
    skill: "rag-memory",
  },
  document_index_status_tool: {
    title: "Knowledge Graph: Document Index Status",
    description:
      "Check which workspace documents are indexed, unindexed, outdated, or failed.",
    component: DefaultSkillPanel,
    icon: ListChecks,
    image: RAGImage,
    skill: "document_index_status_tool",
  },
  "document-ingest-agent": {
    title: `Knowledge Graph: ${t("agent.skill.ingest.title")}`,
    description: t("agent.skill.ingest.description"),
    component: DefaultSkillPanel,
    icon: FilePlus,
    image: SummarizeImage,
    skill: "document-ingest-agent",
  },
  "document-summarizer": {
    title: `Knowledge Graph: ${t("agent.skill.view.title")}`,
    description: t("agent.skill.view.description"),
    component: DefaultSkillPanel,
    icon: File,
    image: SummarizeImage,
    skill: "document-summarizer",
  },
  "web-scraping": {
    title: `Intelligence: ${t("agent.skill.scrape.title")}`,
    description: t("agent.skill.scrape.description"),
    component: DefaultSkillPanel,
    icon: Browser,
    image: ScrapeWebsitesImage,
    skill: "web-scraping",
  },
  [WEB_BROWSING_SKILL]: {
    title: t("agent.skill.web.title"),
    description: t("agent.skill.web.description"),
    component: AgentWebSearchSelection,
    icon: Browser,
    image: ScrapeWebsitesImage,
    skill: WEB_BROWSING_SKILL,
  },
  "request-user-input": {
    title: `Intelligence: ${t("agent.skill.surveys.title")}`,
    description: t("agent.skill.surveys.description"),
    component: DefaultSkillPanel,
    icon: ChatCircleDots,
    image: RAGImage,
    skill: "request-user-input",
  },
});

export const getConfigurableSkills = (
  t,
  { fileSystemAgentAvailable = true } = {}
) => ({
  ...(fileSystemAgentAvailable && {
    "filesystem-agent": {
      title: t("agent.skill.filesystem.title"),
      description: t("agent.skill.filesystem.description"),
      component: FileSystemSkillPanel,
      skill: "filesystem-agent",
      icon: FolderOpen,
      image: FileSystemImage,
    },
  }),
  "create-chart": {
    title: t("agent.skill.generate.title"),
    description: t("agent.skill.generate.description"),
    component: GenericSkillPanel,
    skill: "create-chart",
    icon: ChartBar,
    image: GenerateChartsImage,
  },
  "sql-agent": {
    title: t("agent.skill.sql.title"),
    description: t("agent.skill.sql.description"),
    component: AgentSQLConnectorSelection,
    skill: "sql-agent",
  },
  "shell-agent": {
    title: "Shell",
    description:
      "执行本地 Shell 命令。仅在开放（Open）文件访问模式下可用，并且每次执行都需要用户批准。",
    component: GenericSkillPanel,
    skill: "shell-agent",
    icon: Terminal,
    image: FileSystemImage,
  },
});

export const getAppIntegrationSkills = (t) => ({
  "gmail-agent": {
    title: t("agent.skill.gmail.title"),
    description: t("agent.skill.gmail.description"),
    component: GMailSkillPanel,
    skill: "gmail-agent",
    Icon: ({ size }) => (
      <img src={GMailIcon} alt="GMail" width={size} height={size} />
    ),
    mode: ["singleUserOnly"],
  },
  "google-calendar-agent": {
    title: t("agent.skill.googleCalendar.title"),
    description: t("agent.skill.googleCalendar.description"),
    component: GoogleCalendarSkillPanel,
    skill: "google-calendar-agent",
    Icon: ({ size }) => (
      <img
        src={GoogleCalendarIcon}
        alt="Google Calendar"
        width={size}
        height={size}
      />
    ),
    mode: ["singleUserOnly"],
  },
  "outlook-agent": {
    title: t("agent.skill.outlook.title"),
    description: t("agent.skill.outlook.description"),
    component: OutlookSkillPanel,
    skill: "outlook-agent",
    Icon: ({ size }) => (
      <img src={OutlookIcon} alt="Outlook" width={size} height={size} />
    ),
    mode: ["singleUserOnly"],
  },
});
