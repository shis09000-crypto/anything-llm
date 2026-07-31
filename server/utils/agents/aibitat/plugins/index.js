const { webBrowsing } = require("./web-browsing.js");
const { webScraping } = require("./web-scraping.js");
const { websocket } = require("./websocket.js");
const { docSummarizer } = require("./summarize.js");
const { chatHistory } = require("./chat-history.js");
const { memory } = require("./memory.js");
const { saveMemory } = require("./save-memory.js");
const { documentIngestAgent } = require("./document-ingest-agent.js");
const { rechart } = require("./rechart.js");
const { sqlAgent } = require("./sql-agent/index.js");
const { filesystemAgent } = require("./filesystem/index.js");
const { createFilesAgent } = require("./create-files/index.js");
const { gmailAgent } = require("./gmail/index.js");
const { outlookAgent } = require("./outlook/index.js");
const { googleCalendarAgent } = require("./google-calendar/index.js");
const { shellAgent } = require("./shell/index.js");
const { documentIndexStatusTool } = require("./document-index-status-tool.js");
const { workspaceSupplementTool } = require("./workspace-supplement-tool.js");
const { requestUserInput } = require("./request-user-input.js");
const { cryptoMarketAgent } = require("./crypto-market");
const { cryptoAccountAgent } = require("./crypto-account");
const { weatherAgent } = require("./weather");
const { globalMarketAgent } = require("./global-market");
const { goldMarketAgent } = require("./gold-market");
const { documentFormattingAgent } = require("./document-formatting");
const { browserAgent } = require("./browser");

module.exports = {
  webScraping,
  webBrowsing,
  websocket,
  docSummarizer,
  chatHistory,
  memory,
  saveMemory,
  documentIngestAgent,
  rechart,
  sqlAgent,
  filesystemAgent,
  createFilesAgent,
  gmailAgent,
  outlookAgent,
  googleCalendarAgent,
  shellAgent,
  documentIndexStatusTool,
  workspaceSupplementTool,
  requestUserInput,
  cryptoMarketAgent,
  cryptoAccountAgent,
  weatherAgent,
  globalMarketAgent,
  goldMarketAgent,
  documentFormattingAgent,
  browserAgent,

  // Plugin name aliases so they can be pulled by slug as well.
  [webScraping.name]: webScraping,
  [webBrowsing.name]: webBrowsing,
  [websocket.name]: websocket,
  [docSummarizer.name]: docSummarizer,
  [chatHistory.name]: chatHistory,
  [memory.name]: memory,
  [saveMemory.name]: saveMemory,
  [documentIngestAgent.name]: documentIngestAgent,
  [rechart.name]: rechart,
  [sqlAgent.name]: sqlAgent,
  [filesystemAgent.name]: filesystemAgent,
  [createFilesAgent.name]: createFilesAgent,
  [gmailAgent.name]: gmailAgent,
  [outlookAgent.name]: outlookAgent,
  [googleCalendarAgent.name]: googleCalendarAgent,
  [shellAgent.name]: shellAgent,
  [documentIndexStatusTool.name]: documentIndexStatusTool,
  [workspaceSupplementTool.name]: workspaceSupplementTool,
  [requestUserInput.name]: requestUserInput,
  [cryptoMarketAgent.name]: cryptoMarketAgent,
  [cryptoAccountAgent.name]: cryptoAccountAgent,
  [weatherAgent.name]: weatherAgent,
  [globalMarketAgent.name]: globalMarketAgent,
  [goldMarketAgent.name]: goldMarketAgent,
  [documentFormattingAgent.name]: documentFormattingAgent,
  [browserAgent.name]: browserAgent,
};
