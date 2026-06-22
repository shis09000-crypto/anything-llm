const {
  appendUserPersonalizationToSystemPrompt,
  normalizePersonalizationBioLabels,
  personalizationProfileFromBio,
  stripUserPersonalizationPromptBlock,
  userPersonalizationPromptBlock,
} = require("../../../utils/chats/personalizationContext");
const { User } = require("../../../models/user");

describe("personalizationContext", () => {
  const profile = [
    "<personalization_profile>",
    "你的昵称: 少爷",
    "模型的身份: 女仆",
    "风格: 温柔，严谨",
    "你的详情: 你叫安雅。",
    "</personalization_profile>",
  ].join("\n");

  it("does not inject when bio has no personalization profile", async () => {
    await expect(
      userPersonalizationPromptBlock({ bio: "" })
    ).resolves.toBe("");
    await expect(
      userPersonalizationPromptBlock({ bio: "普通简介" })
    ).resolves.toBe("");
  });

  it("builds a model-facing personalization context block", async () => {
    const block = await userPersonalizationPromptBlock({ bio: profile });

    expect(block).toContain("<user_personalization_context>");
    expect(block).toContain("模型的身份: 女仆");
    expect(block).toContain("你的详情: 你叫安雅。");
    expect(block).toContain("</user_personalization_context>");
  });

  it("can resolve the personalization profile by user id", async () => {
    const getSpy = jest.spyOn(User, "get").mockResolvedValue({ bio: profile });

    await expect(userPersonalizationPromptBlock({ id: 4 })).resolves.toContain(
      "模型的身份: 女仆"
    );
    expect(getSpy).toHaveBeenCalledWith({ id: 4 });

    getSpy.mockRestore();
  });

  it("normalizes the old identity label", () => {
    const oldBio = [
      "<personalization_profile>",
      "你的身份: 女仆",
      "</personalization_profile>",
    ].join("\n");

    expect(normalizePersonalizationBioLabels(oldBio)).toContain(
      "模型的身份: 女仆"
    );
    expect(personalizationProfileFromBio(oldBio)).toContain(
      "模型的身份: 女仆"
    );
  });

  it("appends personalization after the system prompt without duplicating", async () => {
    const first = await appendUserPersonalizationToSystemPrompt("System", {
      bio: profile,
    });
    const second = await appendUserPersonalizationToSystemPrompt(first, {
      bio: profile,
    });

    expect(second.startsWith("System\n\n<user_personalization_context>")).toBe(
      true
    );
    expect(second.match(/<user_personalization_context>/g)).toHaveLength(1);
  });

  it("strips an existing personalization block", async () => {
    const prompt = await appendUserPersonalizationToSystemPrompt("System", {
      bio: profile,
    });

    expect(stripUserPersonalizationPromptBlock(prompt)).toBe("System");
  });
});
