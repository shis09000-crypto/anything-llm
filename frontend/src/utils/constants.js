export function isLoopbackHost(hostname = "") {
  return ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(hostname);
}

function isPrivateIpv4Host(hostname = "") {
  const parts = String(hostname || "")
    .split(".")
    .map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }

  const [first, second] = parts;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isLocalDevelopmentHost(hostname = "") {
  return isLoopbackHost(hostname) || isPrivateIpv4Host(hostname);
}

export function resolveApiBase(configuredBase = "/api") {
  if (!configuredBase || !/^https?:\/\//i.test(configuredBase)) {
    return configuredBase || "/api";
  }
  if (typeof window === "undefined") return configuredBase;

  try {
    const apiUrl = new URL(configuredBase);
    const pageHost = window.location.hostname;
    if (
      window.location.protocol === "https:" &&
      apiUrl.protocol === "http:" &&
      (isLoopbackHost(apiUrl.hostname) || apiUrl.hostname === pageHost)
    ) {
      return "/api";
    }
    if (isLoopbackHost(apiUrl.hostname) && !isLoopbackHost(pageHost)) {
      apiUrl.hostname = pageHost;
      return apiUrl.toString().replace(/\/$/, "");
    }
    if (
      import.meta.env.DEV &&
      apiUrl.protocol === "http:" &&
      window.location.protocol === "http:" &&
      apiUrl.hostname !== pageHost &&
      isLocalDevelopmentHost(apiUrl.hostname) &&
      isLocalDevelopmentHost(pageHost)
    ) {
      apiUrl.hostname = pageHost;
      return apiUrl.toString().replace(/\/$/, "");
    }
  } catch {}

  return configuredBase;
}

const devProxyTarget = import.meta.env?.VITE_DEV_API_PROXY_TARGET;
const configuredApiBase = import.meta.env.VITE_API_BASE || "/api";

export const API_BASE = resolveApiBase(
  import.meta.env.DEV && devProxyTarget ? "/api" : configuredApiBase
);
export const ONBOARDING_SURVEY_URL = "https://onboarding.anythingllm.com";

export const AUTH_USER = "anythingllm_user";
export const AUTH_TOKEN = "anythingllm_authToken";
export const AUTH_TIMESTAMP = "anythingllm_authTimestamp";
export const LAST_USER_ACTION_AT = "athena_lastUserActionAt";
export const ZK_LOGIN_DEVICE_INDEX = "athena_zkLoginDeviceIndex";
export const COMPLETE_QUESTIONNAIRE = "anythingllm_completed_questionnaire";
export const SEEN_DOC_PIN_ALERT = "anythingllm_pinned_document_alert";
export const SEEN_WATCH_ALERT = "anythingllm_watched_document_alert";
export const LAST_VISITED_WORKSPACE = "anythingllm_last_visited_workspace";
export const LAST_VISITED_WORKSPACE_THREADS =
  "anythingllm_last_visited_workspace_threads";
export const USER_PROMPT_INPUT_MAP = "anythingllm_user_prompt_input_map";
export const PENDING_HOME_MESSAGE = "anythingllm_pending_home_message";

export const APPEARANCE_SETTINGS = "anythingllm_appearance_settings";

export const OLLAMA_COMMON_URLS = [
  "http://127.0.0.1:11434",
  "http://host.docker.internal:11434",
  "http://172.17.0.1:11434",
];

export const LMSTUDIO_COMMON_URLS = [
  "http://localhost:1234/v1",
  "http://127.0.0.1:1234/v1",
  "http://host.docker.internal:1234/v1",
  "http://172.17.0.1:1234/v1",
];

export const KOBOLDCPP_COMMON_URLS = [
  "http://127.0.0.1:5000/v1",
  "http://localhost:5000/v1",
  "http://host.docker.internal:5000/v1",
  "http://172.17.0.1:5000/v1",
];

export const LOCALAI_COMMON_URLS = [
  "http://127.0.0.1:8080/v1",
  "http://localhost:8080/v1",
  "http://host.docker.internal:8080/v1",
  "http://172.17.0.1:8080/v1",
];

export const DPAIS_COMMON_URLS = [
  "http://127.0.0.1:8553/v1/openai",
  "http://0.0.0.0:8553/v1/openai",
  "http://localhost:8553/v1/openai",
  "http://host.docker.internal:8553/v1/openai",
];

export const NVIDIA_NIM_COMMON_URLS = [
  "http://127.0.0.1:8000/v1/version",
  "http://localhost:8000/v1/version",
  "http://host.docker.internal:8000/v1/version",
  "http://172.17.0.1:8000/v1/version",
];

export const DOCKER_MODEL_RUNNER_COMMON_URLS = [
  "http://localhost:12434/engines/llama.cpp/v1",
  "http://127.0.0.1:12434/engines/llama.cpp/v1",
  "http://model-runner.docker.internal/engines/llama.cpp/v1",
  "http://host.docker.internal:12434/engines/llama.cpp/v1",
  "http://172.17.0.1:12434/engines/llama.cpp/v1",
];

export const LEMONADE_COMMON_URLS = [
  "http://localhost:8000/live",
  "http://127.0.0.1:8000/live",
  "http://host.docker.internal:8000/live",
  "http://172.17.0.1:8000/live",

  // In Lemonade 10.1.0 the base port is 13305
  "http://localhost:13305/live",
  "http://127.0.0.1:13305/live",
  "http://host.docker.internal:13305/live",
  "http://172.17.0.1:13305/live",
];

export function fullApiUrl() {
  if (API_BASE !== "/api") return API_BASE;
  return `${window.location.origin}/api`;
}

export const POPUP_BROWSER_EXTENSION_EVENT = "NEW_BROWSER_EXTENSION_CONNECTION";
