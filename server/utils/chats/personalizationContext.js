const { User } = require("../../models/user");

const PERSONALIZATION_PROFILE_TAG = "personalization_profile";
const USER_PERSONALIZATION_CONTEXT_TAG = "user_personalization_context";
const USER_PERSONALIZATION_CONTEXT_REGEX = new RegExp(
  `\\n*\\s*<${USER_PERSONALIZATION_CONTEXT_TAG}>[\\s\\S]*?<\\/${USER_PERSONALIZATION_CONTEXT_TAG}>\\s*`,
  "g"
);
const PERSONALIZATION_PROFILE_REGEX = new RegExp(
  `<${PERSONALIZATION_PROFILE_TAG}>[\\s\\S]*?<\\/${PERSONALIZATION_PROFILE_TAG}>`,
  "i"
);

function normalizePersonalizationBioLabels(bio = "") {
  return String(bio || "").replace(/^你的身份:/gm, "模型的身份:");
}

function personalizationProfileFromBio(bio = "") {
  const normalizedBio = normalizePersonalizationBioLabels(bio);
  const match = normalizedBio.match(PERSONALIZATION_PROFILE_REGEX);
  if (!match) return "";
  return match[0].trim();
}

async function resolveUserBio(user = null) {
  if (!user) return "";
  if (typeof user.bio === "string" && user.bio.trim()) return user.bio;
  if (!user.id) return "";

  const freshUser = await User.get({ id: Number(user.id) });
  return freshUser?.bio || "";
}

async function userPersonalizationPromptBlock(user = null) {
  const bio = await resolveUserBio(user);
  const profile = personalizationProfileFromBio(bio);
  if (!profile) return "";

  return [
    `<${USER_PERSONALIZATION_CONTEXT_TAG}>`,
    "以下是当前用户保存的个性化配置。它定义了用户希望模型采用的身份、称呼、对话风格与背景。",
    "除非更高优先级的系统或开发者指令冲突，否则在与该用户对话时遵循它。",
    profile,
    `</${USER_PERSONALIZATION_CONTEXT_TAG}>`,
  ].join("\n");
}

function stripUserPersonalizationPromptBlock(text = "") {
  if (typeof text !== "string") return text;
  return text.replace(USER_PERSONALIZATION_CONTEXT_REGEX, "").trimEnd();
}

async function appendUserPersonalizationToSystemPrompt(
  systemPrompt = "",
  user = null
) {
  const base = stripUserPersonalizationPromptBlock(String(systemPrompt || ""));
  const block = await userPersonalizationPromptBlock(user);
  if (!block) return base;
  return base ? `${base}\n\n${block}` : block;
}

module.exports = {
  PERSONALIZATION_PROFILE_TAG,
  USER_PERSONALIZATION_CONTEXT_TAG,
  appendUserPersonalizationToSystemPrompt,
  normalizePersonalizationBioLabels,
  personalizationProfileFromBio,
  stripUserPersonalizationPromptBlock,
  userPersonalizationPromptBlock,
};
