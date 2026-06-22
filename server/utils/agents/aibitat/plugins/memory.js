const { v4 } = require("uuid");
const { getVectorDbClass, getLLMProvider } = require("../../../helpers");
const { Deduplicator } = require("../utils/dedupe");

const memory = {
  name: "rag-memory",
  startupConfig: {
    params: {},
  },
  plugin: function () {
    return {
      name: this.name,
      setup(aibitat) {
        aibitat.function({
          super: aibitat,
          tracker: new Deduplicator(),
          name: this.name,
          description:
            "Search local documents, workspace files, or this workspace's vector memory for relevant information. The store action writes only to the current workspace vector database. Do not use store for account-level long-term memory, personal preferences, facts, projects, decisions, open topics, interests, or sensitive memories; use save_memory for those.",
          examples: [
            {
              prompt: "Check my files for information about the project",
              call: JSON.stringify({
                action: "search",
                content: "<project information to search for>",
              }),
            },
            {
              prompt: "What do you know about Plato's motives?",
              call: JSON.stringify({
                action: "search",
                content: "What are the facts about Plato's motives?",
              }),
            },
            {
              prompt: "Store this project note in the workspace knowledge base",
              call: JSON.stringify({
                action: "store",
                content:
                  "Workspace vector note: the current project uses Athena as the knowledge operations UI.",
              }),
            },
          ],
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["search", "store"],
                description:
                  "The action we want to take to search for existing similar context or storage of new context.",
              },
              content: {
                type: "string",
                description:
                  "The plain text to search our local documents with or to store in our vector database.",
              },
            },
            additionalProperties: false,
          },
          handler: async function ({ action = "", content = "" }) {
            try {
              const { isDuplicate } = this.tracker.isDuplicate(this.name, {
                action,
                content,
              });
              if (isDuplicate)
                return `This was a duplicated call and it's output will be ignored.`;

              let response = "There was nothing to do.";
              if (action === "search") response = await this.search(content);
              if (action === "store") response = await this.store(content);

              this.tracker.trackRun(this.name, { action, content });
              return response;
            } catch (error) {
              console.log(error);
              return `There was an error while calling the function. ${error.message}`;
            }
          },
          search: async function (query = "") {
            try {
              const workspace = this.super.handlerProps.invocation.workspace;
              const LLMConnector = getLLMProvider({
                provider: workspace?.chatProvider,
                model: workspace?.chatModel,
              });
              const vectorDB = getVectorDbClass();
              const { contextTexts = [] } =
                await vectorDB.performSimilaritySearch({
                  namespace: workspace.slug,
                  input: query,
                  LLMConnector,
                  topN: workspace?.topN ?? 4,
                  rerank: workspace?.vectorSearchMode === "rerank",
                });

              if (contextTexts.length === 0) {
                this.super.introspect(
                  `${this.caller}: I didn't find anything locally that would help answer this question.`
                );
                return "There was no additional context found for that query. We should search the web for this information.";
              }

              this.super.introspect(
                `${this.caller}: Found ${contextTexts.length} additional piece of context to help answer this question.`
              );

              let combinedText = "Additional context for query:\n";
              for (const text of contextTexts) combinedText += text + "\n\n";
              return combinedText;
            } catch (error) {
              this.super.handlerProps.log(
                `memory.search raised an error. ${error.message}`
              );
              return `An error was raised while searching the vector database. ${error.message}`;
            }
          },
          store: async function (content = "") {
            try {
              if (!content || String(content).trim().length === 0)
                return "The content was not embedded because it was empty.";

              // Thread compaction is deterministic per-thread state and must
              // not be stored here. rag-memory.store remains only for explicit
              // user requests to remember/save long-term vector memories.
              const workspace = this.super.handlerProps.invocation.workspace;
              const vectorDB = getVectorDbClass();
              this.super.handlerProps.log("memory.store: direct memory write");
              const { error } = await vectorDB.addDocumentToNamespace(
                workspace.slug,
                {
                  docId: v4(),
                  id: v4(),
                  url: "file://embed-via-agent.txt",
                  title: "agent-memory.txt",
                  docAuthor: "@agent",
                  description: "Unknown",
                  docSource: "a text file stored by the workspace agent.",
                  chunkSource: "",
                  published: new Date().toLocaleString(),
                  wordCount: content.split(" ").length,
                  pageContent: content,
                  token_count_estimate: 0,
                },
                null
              );

              if (!!error) {
                this.super.handlerProps.log(
                  `memory.store failed to embed content. ${error}`
                );
                return `The content was failed to be embedded properly. ${error}`;
              }
              this.super.introspect(
                `${this.caller}: I saved the content to long-term memory in this workspaces vector database.`
              );
              return "The content given was successfully embedded. There is nothing else to do.";
            } catch (error) {
              this.super.handlerProps.log(
                `memory.store raised an error. ${error.message}`
              );
              return `Let the user know this action was not successful. An error was raised while storing data in the vector database. ${error.message}`;
            }
          },
        });
      },
    };
  },
};

module.exports = {
  memory,
};
