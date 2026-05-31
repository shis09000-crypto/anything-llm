const { log, conclude } = require("./helpers/index.js");
const {
  refreshRecentThreadTitles,
} = require("../utils/chats/threadTitleGeneration");

(async () => {
  try {
    if (process.env.THREAD_TITLE_REFRESH_ENABLED === "false") {
      log("Thread title refresh disabled. Exiting.");
      return;
    }

    const result = await refreshRecentThreadTitles({
      pageSize: Number(process.env.THREAD_TITLE_REFRESH_PAGE_SIZE) || 100,
      waitForIdle: true,
    });
    log(`Thread title refresh complete: ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(error);
    log(`Thread title refresh failed: ${error.message}`);
  } finally {
    conclude();
  }
})();
