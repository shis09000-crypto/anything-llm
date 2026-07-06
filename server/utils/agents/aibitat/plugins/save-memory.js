const { lazyDataAccessFacade } = require("../../../dataAccess/lazyFacade");
const User = lazyDataAccessFacade("user");
const UserMemory = lazyDataAccessFacade("userMemory");
const {
  SAVE_MEMORY_TOOL_NAME,
  approvalPayloadForMemory,
  normalizeSaveMemoryArgs,
} = require("../../../chats/saveMemoryTool");

const saveMemory = {
  name: SAVE_MEMORY_TOOL_NAME,
  startupConfig: {
    params: {},
  },
  plugin: function () {
    return {
      name: this.name,
      setup(aibitat) {
        aibitat.function({
          super: aibitat,
          name: this.name,
          description:
            "Save an account-level long-term memory when the user explicitly asks to remember, permanently save, or write something into long-term memory. This writes to the user's account memory blocks, not the workspace vector database. Every call requires user approval before saving.",
          examples: [
            {
              prompt: "记住：以后回答都用中文",
              call: JSON.stringify({
                category: "preferences",
                title: "中文回答偏好",
                detail: "以后回答都用中文。",
                source: "explicit_user_request",
                confidence: 1,
                isSensitive: false,
              }),
            },
            {
              prompt: "帮我写入长期记忆：Primary Owner 不可删除",
              call: JSON.stringify({
                category: "decisions",
                title: "Primary Owner 不可删除",
                detail: "Primary Owner 账号不能被删除。",
                source: "explicit_user_request",
                confidence: 1,
                isSensitive: false,
              }),
            },
          ],
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              category: {
                type: "string",
                enum: UserMemory.categories,
                description:
                  "One of the six fixed memory modules: preferences, projects, facts, decisions, open_topics, interests.",
              },
              title: {
                type: "string",
                description: "A short second-level memory title.",
              },
              detail: {
                type: "string",
                description: "The exact long-term memory content to save.",
              },
              source: {
                type: "string",
                description:
                  "Use explicit_user_request for user-approved long-term memory.",
              },
              confidence: {
                type: "number",
                description: "Use 1.0 for explicit user memory requests.",
              },
              isSensitive: {
                type: "boolean",
                description:
                  "True only when the memory contains private or sensitive information.",
              },
            },
            required: ["category", "title", "detail", "isSensitive"],
            additionalProperties: false,
          },
          handler: async function (args = {}) {
            try {
              const input = normalizeSaveMemoryArgs(args);
              const payload = approvalPayloadForMemory(input);

              if (typeof this.super.requestToolApproval !== "function") {
                return "保存长期记忆需要用户确认，但当前 Agent 会话无法显示确认卡。";
              }

              const approval = await this.super.requestToolApproval({
                skillName: SAVE_MEMORY_TOOL_NAME,
                payload,
                description: `保存长期记忆：${input.title}`,
                forceApproval: true,
                allowAlwaysAllow: false,
              });
              if (!approval.approved)
                return approval.message || "已取消保存记忆。";

              const sessionUserId =
                this.super.handlerProps?.invocation?.user_id || null;
              const sessionUser = sessionUserId
                ? await User.get({ id: Number(sessionUserId) })
                : null;
              const memoryOwnerId =
                UserMemory.memoryOwnerIdFromSessionUser(sessionUser);
              const result = await UserMemory.saveActiveMemory(
                memoryOwnerId,
                input
              );

              this.super.introspect(
                `${this.caller}: saved account-level long-term memory "${input.title}".`
              );
              return JSON.stringify({
                success: true,
                id: result.memory.id,
                category: result.memory.category,
                title: input.title,
                detail: input.isSensitive
                  ? UserMemory.maskedText
                  : input.detail,
                source: result.memory.source,
                confidence: 1,
                isSensitive: input.isSensitive,
                created: result.created,
                replaced: result.replaced,
              });
            } catch (error) {
              this.super.handlerProps?.log?.(
                `save_memory raised an error. ${error.message}`
              );
              return `长期记忆保存失败：${error.message}`;
            }
          },
        });
      },
    };
  },
};

module.exports = {
  saveMemory,
};
