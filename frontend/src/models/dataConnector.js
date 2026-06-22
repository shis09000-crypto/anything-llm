import { postJson } from "@/lib/communication/apiClient";
import showToast from "@/utils/toast";

const DataConnector = {
  github: {
    branches: async ({ repo, accessToken }) => {
      return await postJson(
        "/ext/github/branches",
        { repo, accessToken },
        { cache: "force-cache" }
      )
        .then(({ data }) => data)
        .then((res) => {
          if (!res.success) throw new Error(res.reason);
          return res.data;
        })
        .then((data) => {
          return { branches: data?.branches || [], error: null };
        })
        .catch((e) => {
          console.error(e);
          showToast(e.message, "error");
          return { branches: [], error: e.message };
        });
    },
    collect: async function ({ repo, accessToken, branch, ignorePaths = [] }) {
      return await postJson("/ext/github/repo", {
        repo,
        accessToken,
        branch,
        ignorePaths,
      })
        .then(({ data }) => data)
        .then((res) => {
          if (!res.success) throw new Error(res.reason);
          return { data: res.data, error: null };
        })
        .catch((e) => {
          console.error(e);
          return { data: null, error: e.message };
        });
    },
  },
  gitlab: {
    branches: async ({ repo, accessToken }) => {
      return await postJson(
        "/ext/gitlab/branches",
        { repo, accessToken },
        { cache: "force-cache" }
      )
        .then(({ data }) => data)
        .then((res) => {
          if (!res.success) throw new Error(res.reason);
          return res.data;
        })
        .then((data) => {
          return { branches: data?.branches || [], error: null };
        })
        .catch((e) => {
          console.error(e);
          showToast(e.message, "error");
          return { branches: [], error: e.message };
        });
    },
    collect: async function ({
      repo,
      accessToken,
      branch,
      ignorePaths = [],
      fetchIssues = false,
      fetchWikis = false,
    }) {
      return await postJson("/ext/gitlab/repo", {
        repo,
        accessToken,
        branch,
        ignorePaths,
        fetchIssues,
        fetchWikis,
      })
        .then(({ data }) => data)
        .then((res) => {
          if (!res.success) throw new Error(res.reason);
          return { data: res.data, error: null };
        })
        .catch((e) => {
          console.error(e);
          return { data: null, error: e.message };
        });
    },
  },
  youtube: {
    transcribe: async ({ url }) => {
      return await postJson("/ext/youtube/transcript", { url })
        .then(({ data }) => data)
        .then((res) => {
          if (!res.success) throw new Error(res.reason);
          return { data: res.data, error: null };
        })
        .catch((e) => {
          console.error(e);
          return { data: null, error: e.message };
        });
    },
  },
  websiteDepth: {
    scrape: async ({ url, depth, maxLinks }) => {
      return await postJson("/ext/website-depth", { url, depth, maxLinks })
        .then(({ data }) => data)
        .then((res) => {
          if (!res.success) throw new Error(res.reason);
          return { data: res.data, error: null };
        })
        .catch((e) => {
          console.error(e);
          return { data: null, error: e.message };
        });
    },
  },

  confluence: {
    collect: async function ({
      baseUrl,
      spaceKey,
      username,
      accessToken,
      cloud,
      personalAccessToken,
      bypassSSL,
    }) {
      return await postJson("/ext/confluence", {
        baseUrl,
        spaceKey,
        username,
        accessToken,
        cloud,
        personalAccessToken,
        bypassSSL,
      })
        .then(({ data }) => data)
        .then((res) => {
          if (!res.success) throw new Error(res.reason);
          return { data: res.data, error: null };
        })
        .catch((e) => {
          console.error(e);
          return { data: null, error: e.message };
        });
    },
  },

  drupalwiki: {
    collect: async function ({ baseUrl, spaceIds, accessToken }) {
      return await postJson("/ext/drupalwiki", {
        baseUrl,
        spaceIds,
        accessToken,
      })
        .then(({ data }) => data)
        .then((res) => {
          if (!res.success) throw new Error(res.reason);
          return { data: res.data, error: null };
        })
        .catch((e) => {
          console.error(e);
          return { data: null, error: e.message };
        });
    },
  },
  obsidian: {
    collect: async function ({ files }) {
      return await postJson("/ext/obsidian/vault", { files })
        .then(({ data }) => data)
        .then((res) => {
          if (!res.success) throw new Error(res.reason);
          return { data: res.data, error: null };
        })
        .catch((e) => {
          console.error(e);
          return { data: null, error: e.message };
        });
    },
  },

  paperlessNgx: {
    collect: async function ({ baseUrl, apiToken }) {
      return await postJson("/ext/paperless-ngx", { baseUrl, apiToken })
        .then(({ data }) => data)
        .then((res) => {
          if (!res.success) throw new Error(res.reason);
          return { data: res.data, error: null };
        })
        .catch((e) => {
          console.error(e);
          return { data: null, error: e.message };
        });
    },
  },
};

export default DataConnector;
