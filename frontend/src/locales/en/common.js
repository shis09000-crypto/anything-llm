const TRANSLATIONS = {
  onboarding: {
    home: {
      welcome: "Welcome",
      getStarted: "Get Started",
    },
    llm: {
      title: "LLM Preference",
      description:
        "Athena can work with many LLM providers. This will be the service which handles chatting.",
    },
    userSetup: {
      title: "User Setup",
      description: "Configure your user settings.",
      howManyUsers: "How many users will be using this instance?",
      justMe: "Just me",
      myTeam: "My team",
      instancePassword: "Instance Password",
      setPassword: "Would you like to set up a password?",
      passwordReq: "Passwords must be at least 8 characters.",
      passwordWarn:
        "It's important to save this password because there is no recovery method.",
      adminUsername: "Admin account username",
      adminPassword: "Admin account password",
      adminPasswordReq: "Passwords must be at least 8 characters.",
      teamHint:
        "By default, you will be the only admin. Once onboarding is completed you can create and invite others to be users or admins. Do not lose your password as only admins can reset passwords.",
    },
    data: {
      title: "Data Handling & Privacy",
      description:
        "We are committed to transparency and control when it comes to your personal data.",
      settingsHint:
        "These settings can be reconfigured at any time in the settings.",
    },
    survey: {
      title: "Welcome to Athena",
      description: "Help us make Athena built for your needs. Optional.",
      email: "What's your email?",
      useCase: "What will you use Athena for?",
      useCaseWork: "For work",
      useCasePersonal: "For personal use",
      useCaseOther: "Other",
      comment: "How did you hear about Athena?",
      commentPlaceholder:
        "Reddit, Twitter, GitHub, YouTube, etc. - Let us know how you found us!",
      skip: "Skip Survey",
      thankYou: "Thank you for your feedback!",
    },
  },
  common: {
    productName: "Athena",
    defaultSiteTitle: "Athena | Knowledge Operating System",
    controls: {
      settings: "Settings",
      settingsDescription:
        "Open system settings to adjust appearance, providers, security, and workspace management.",
      workspaceSettings: "Workspace settings",
      workspaceSettingsDescription:
        "Open this workspace's settings to adjust appearance, documents, members, and behavior.",
      backToWorkspace: "Back to workspaces",
      showSidebar: "Show sidebar ({{shortcut}})",
      hideSidebar: "Hide sidebar ({{shortcut}})",
    },
    clear: "Clear",
    thread: "Thread",
    default: "Default",
    overviewPage: "Overview",
    newThread: "New Thread",
    startingThread: "Starting thread...",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    "return-running-thread": "Return to running thread",
    "workspaces-name": "Workspace Name",
    selection: "Model Selection",
    saving: "Saving...",
    save: "Save changes",
    previous: "Previous Page",
    next: "Next Page",
    optional: "Optional",
    yes: "Yes",
    no: "No",
    on: "On",
    none: "None",
    stopped: "Stopped",
    search: "Search",
    developmentMode: "Development mode",
    username_requirements:
      "Username must be 2-32 characters, start with a lowercase letter, and only contain lowercase letters, numbers, underscores, hyphens, and periods.",
    loading: "Loading",
    refresh: "Refresh",
  },
  home: {
    welcome: "Welcome",
    chooseWorkspace: "Choose a workspace to start chatting!",
    notAssigned:
      "You currently aren't assigned to any workspaces.\nPlease contact your administrator to request access to a workspace.",
    goToWorkspace: 'Go to "{{workspace}}"',
  },
  settings: {
    title: "Instance Settings",
    invites: "Invites",
    users: "Users",
    workspaces: "Workspaces",
    "workspace-chats": "Workspace Chats",
    customization: "Customization",
    interface: "UI Preferences",
    branding: "Branding & Whitelabeling",
    chat: "Chat",
    "api-keys": "Developer API",
    llm: "LLM",
    transcription: "Transcription",
    embedder: "Embedder",
    reranker: "Rerank Model",
    ocr: "OCR Model",
    vision: "Vision Model",
    "text-splitting": "Text Splitter & Chunking",
    "batch-jobs": "Batch Jobs",
    "voice-speech": "Voice & Speech",
    "vector-database": "Vector Database",
    embeds: "Chat Embed",
    security: "Security",
    "event-logs": "Event Logs",
    "scheduled-jobs": "Scheduled Jobs",
    privacy: "Privacy & Data",
    "ai-providers": "AI Providers",
    "agent-skills": "Agent Skills",
    "community-hub": {
      title: "Community Hub",
      trending: "Explore Trending",
      "your-account": "Your Account",
      "import-item": "Import Item",
    },
    admin: "Admin",
    tools: "Tools",
    "system-prompt-variables": "System Prompt Variables",
    "default-system-prompt": "Default System Prompt",
    "experimental-features": "Experimental Features",
    contact: "Contact Support",
    "browser-extension": "Browser Extension",
    "mobile-app": "Athena Mobile",
    channels: "Channels",
    "available-channels": {
      telegram: "Telegram Connector",
      wechat: "WeChat Connector",
      "advanced-gateway": "Advanced Gateway Connector",
    },
  },
  login: {
    "multi-user": {
      welcome: "Welcome",
      "placeholder-username": "Username",
      "placeholder-password": "Password",
      login: "Login",
      validating: "Validating...",
      "forgot-pass": "Forgot password",
      reset: "Reset",
    },
    "sign-in":
      "Enter your username and password to access your {{appName}} instance.",
    "password-reset": {
      title: "Password Reset",
      description:
        "Provide the necessary information below to reset your password.",
      "recovery-codes": "Recovery Codes",
      "back-to-login": "Back to Login",
    },
  },
  "main-page": {
    greeting: "How can I help you today?",
    quickActions: {
      createAgent: "Create an Agent",
      editWorkspace: "Edit Workspace",
      uploadDocument: "Upload a Document",
    },
  },
  "new-workspace": {
    title: "New Workspace",
    placeholder: "My Workspace",
  },
  "workspaces—settings": {
    general: "General Settings",
    chat: "Chat Settings",
    vector: "Vector Database",
    health: "Health Center",
    reading: "Reading Tools",
    members: "Members",
    agent: "Agent Configuration",
  },
  "reading-tools": {
    eyebrow: "Reading tools",
    title: "Font size and reading preview",
    description:
      "Font size is a local browser reading preference. It only affects chat reading on this device and is not saved to workspace settings.",
    sizeTitle: "Font size",
    previewTitle: "Live preview",
    currentSelection: "Current selection: {{label}}",
    customSliderLabel: "Custom font size",
    customRange: "{{min}}px to {{max}}px",
    userPreview:
      "User message preview: Please organize this material into a clear knowledge structure.",
    options: {
      small: {
        label: "Small",
        description: "More compact, useful for scanning long conversations.",
      },
      normal: {
        label: "Standard",
        description: "The default Athena reading size.",
      },
      large: {
        label: "Large",
        description: "More comfortable for long reading sessions and demos.",
      },
      custom: {
        label: "Custom",
        labelWithSize: "Custom {{size}}px",
        description: "Drag the slider in 1px steps.",
      },
    },
    previewMarkdown: `### Assistant response preview

This is a piece of **bold Markdown text** for checking whether font size, line height, and emphasis feel comfortable.

- List items keep clear spacing
- English and 中文 text can appear together

> Block quotes show source excerpts or reasoning notes.

\`\`\`js
const readable = true;
\`\`\`
`,
  },
  "workspace-health": {
    unavailable: "N/A",
    unknown: "Unknown",
    unknownEyebrow: "Status unavailable",
    processing: "Processing",
    processingEyebrow: "Background tasks are running",
    healthy: "Healthy",
    healthyEyebrow: "Workspace is running well",
    attention: "Needs attention",
    attentionEyebrow: "Minor risks detected",
    degraded: "Degraded",
    degradedEyebrow: "Needs investigation",
    critical: "Critical",
    criticalEyebrow: "Needs immediate action",
    warning: "Warning",
    info: "Info",
    scoreUnit: "pts",
    ariaOpen:
      "Workspace health status: {{score}}, {{status}}. Press Enter to open the health center.",
    title: "Workspace Health Center",
    eyebrow: "Workspace observability",
    description:
      "A lightweight observability view for graph data, repair jobs, node metrics, background workers, queues, model services, and caches. Refreshing only updates the health aggregation cache and will not trigger embedding, vector rebuilds, graph extraction, or repair jobs.",
    refresh: "Refresh health",
    refreshAfter: "Refresh in {{seconds}}s",
    healthScore: "Workspace health score",
    lastUpdated: "Last updated: {{time}}",
    summaryCache: "Summary cache: {{time}}",
    latestActivity: "Latest activity: {{time}}",
    workerHeartbeat: "Worker heartbeat: {{time}}",
    summaryFallback: "Health status is temporarily unavailable",
    currentIssues: "Current issues",
    scoreSources: "Score impact sources",
    noScoreSources:
      "There are no active score deductions. This issue may have recovered in the latest health aggregation.",
    pointsLost: "-{{points}} pts",
    severity: "Severity: {{severity}}",
    cacheNote:
      "Cache note: {{count}} stale traversal cache entries are present. Caches rebuild on demand and do not affect the health score.",
    noIssues: "No issues need immediate attention.",
    processingTitle: "Processing",
    noProcessing: "No health tasks are currently processing.",
    timeline: "Recent activity timeline",
    recentActivity: "Recent activity",
    abnormalEvents: "Abnormal events",
    noRecentActivity: "No recent activity.",
    advancedInfo: "Advanced info",
    advancedDiagnostics: "Advanced diagnostics",
    dataSourceTimes: "Data source times",
    adjustReadingTools: "Adjust reading tools and font size",
    fullDiagnostics: "View full diagnostics",
    activityTitles: {
      nodeMetrics: "node metrics",
      kgExtraction: "KG extraction",
      graphRepair: "graph repair",
      recomputeNodeMetrics: "recompute node metrics",
    },
    activityDetails: {
      processed: "processed",
      succeeded: "succeeded",
      failed: "failed",
      skipped: "skipped",
    },
  },
  "workspace-overview": {
    workspaceOverview: "Workspace overview",
    overviewGenerating: "Generating overview",
    workspaceHealth: "Workspace health",
    unknown: "Unknown",
    healthUnavailable: "Health status unavailable",
    healthNote:
      "A combined reading of recommendations, evidence, relationships, and processing status",
    continueLast: "Continue last research",
    noContinue: "No research path is ready to resume.",
    recommended: "Recommended for you",
    noRecommendations:
      "No recommendations yet. Keep exploring concepts or evidence and this area will get smarter.",
    knowledgeGaps: "Knowledge gaps",
  },
  workspaceSupplement: {
    tool: {
      title: "Tool preview",
      description:
        "These supplements are exposed to the model as an on-demand tool instead of being preloaded into context.",
      availableKinds: "Available supplement types",
      customDocuments: "Custom supplement documents",
      noAvailableSupplements: "No available supplements",
    },
    kinds: {
      structure_json: "Structure notes",
      reading_guide: "Reading guide",
      chapter_overview: "Chapter overview",
      timeline: "Timeline",
      person_map: "Person map",
      concept_index: "Concept index",
      summary_standard: "Summary standard",
    },
    kindDescriptions: {
      structure_json:
        "Used for structure, primary axes, secondary axes, and node parsing standards.",
      reading_guide:
        "Used for reading order, subject boundaries, and learning approach.",
      chapter_overview:
        "Used for chapter roles, chapter relationships, and study focus.",
      timeline: "Used for chronological order, developments, and causality.",
      person_map: "Used for views, influence chains, and comparisons.",
      concept_index:
        "Used for definitions, related concepts, and common mistakes.",
      summary_standard:
        "Used for summary structure, required coverage, and forbidden misreadings.",
    },
    customDocumentDescription:
      "A custom supplement document exposed by its concrete title.",
    structureJsonValid: "Valid structure",
    structureJsonInvalid: "Structure needs review",
    usagePreview: "Preview",
  },
  "system-prompt-variables": {
    title: "System Prompt Variables",
    description:
      "System prompt variables are used to store configuration values that can be referenced in your system prompt to enable dynamic content in your prompts.",
    addVariable: "Add Variable",
    noVariables: "No variables found",
    edit: "Edit",
    columns: {
      key: "Key",
      value: "Value",
      description: "Description",
      type: "Type",
    },
    types: {
      system: "System",
      user: "User",
      workspace: "Workspace",
      static: "Static",
    },
    variableDescriptions: {
      time: "Current time",
      date: "Current date",
      datetime: "Current date and time",
      "user.id": "Current user's ID",
      "user.name": "Current user's username",
      "user.bio": "Current user's bio field from their profile",
      "workspace.id": "Current workspace's ID",
      "workspace.name": "Current workspace's name",
    },
    form: {
      addTitle: "Add New Variable",
      editTitle: "Edit {{key}}",
      keyPlaceholder: "e.g., company_name",
      valuePlaceholder: "e.g., Acme Corp",
      descriptionPlaceholder: "Optional description",
      keyHint:
        "Key must be unique and will be used in prompts as {key}. Only letters, numbers and underscores are allowed.",
      cancel: "Cancel",
      create: "Create variable",
      update: "Update variable",
    },
    deleteConfirm: {
      title: "Delete variable?",
      description:
        'This will delete the variable "{{key}}". This action cannot be undone.',
      confirm: "Delete",
    },
    toasts: {
      created: "Variable created successfully",
      updated: "Variable updated successfully",
      deleted: "Variable deleted successfully",
    },
    errors: {
      prefix: "Error",
      required: "Key and value are required",
      create: "Failed to create variable",
      update: "Failed to update variable",
      delete: "Failed to delete variable",
    },
  },
  "experimental-features": {
    title: "Experimental Features",
    selectFeature: "Select an experimental feature",
    status: {
      on: "On",
      off: "Off",
    },
    toasts: {
      enabledSet: "Experimental Feature set enabled. Reloading the page.",
    },
    tos: {
      title: "Terms of use for experimental features",
      introStart:
        "Experimental features of Athena are features that we are piloting and are",
      introSeparator: " ",
      optIn: "opt-in",
      optInSuffix: ".",
      introEnd:
        "We proactively will condition or warn you on any potential concerns should any exist prior to approval of any feature.",
      risksIntro:
        "Use of any feature on this page can result in, but not limited to, the following possibilities.",
      risks: {
        dataLoss: "Loss of data.",
        qualityChange: "Change in quality of results.",
        storageIncrease: "Increased storage.",
        resourceIncrease: "Increased resource consumption.",
        cost: "Increased cost or use of any connected LLM or embedding provider.",
        bugs: "Potential bugs or issues using Athena.",
      },
      conditionsIntro:
        "Use of an experimental feature also comes with the following list of non-exhaustive conditions.",
      conditions: {
        futureRemoval: "Feature may not exist in future updates.",
        unstable: "The feature being used is not currently stable.",
        availability:
          "The feature may not be available in future versions, configurations, or subscriptions of Athena.",
        privacyStart: "Your privacy settings",
        privacySeparator: " ",
        privacyBold: "will be honored",
        privacyEnd: "with use of any beta feature.",
        mayChange: "These conditions may change in future updates.",
      },
      moreInfoPrefix:
        "Access to any features requires approval of this modal. If you would like to read more you can refer to",
      moreInfoOrEmail: "or email",
      reject: "Reject & close",
      accept: "I understand",
    },
    liveSync: {
      navTitle: "Live Document Sync",
      title: "Automatic Document Content Sync",
      description:
        'Enable the ability to specify a document to be "watched". Watched document\'s content will be regularly fetched and updated in Athena.',
      workspaceUpdate:
        "Watched documents will automatically update in all workspaces they are referenced in at the same time of update.",
      webOnly:
        "This feature only applies to web-based content, such as websites, Confluence, YouTube, and GitHub files.",
      docsLink: "Feature Documentation and Warnings",
      manageLink: "Manage Watched Documents",
      toasts: {
        enabled: "Live document content sync has been enabled.",
        disabled: "Live document content sync has been disabled.",
      },
      errors: {
        update: "Failed to update status of feature.",
      },
      manage: {
        title: "Watched documents",
        description:
          "These are all the documents that are currently being watched in your instance. The content of these documents will be periodically synced.",
        columns: {
          documentName: "Document Name",
          lastSynced: "Last Synced",
          nextRefresh: "Time until next refresh",
          createdOn: "Created On",
        },
      },
    },
  },
  "audio-preference": {
    stt: {
      title: "Speech-to-text Preference",
      description:
        "Here you can specify what kind of text-to-speech and speech-to-text providers you would want to use in your Athena experience. By default, we use the browser's built in support for these services, but you may want to use others.",
      searchPlaceholder: "Search speech to text providers",
    },
    tts: {
      title: "Text-to-speech Preference",
      description:
        "Here you can specify what kind of text-to-speech providers you would want to use in your Athena experience. By default, we use the browser's built in support for these services, but you may want to use others.",
      searchPlaceholder: "Search text to speech providers",
    },
    provider: "Provider",
    noConfiguration: "There is no configuration needed for this provider.",
    loadingModels: "-- loading available models --",
    providers: {
      native: {
        name: "System native",
        sttDescription:
          "Uses your browser's built in STT service if supported.",
        ttsDescription:
          "Uses your browser's built in TTS service if supported.",
      },
      openai: {
        description: "Use OpenAI's text to speech voices.",
      },
      elevenlabs: {
        description: "Use ElevenLabs's text to speech voices and technology.",
      },
      piper: {
        description: "Run TTS models locally in your browser privately.",
      },
      openaiCompatible: {
        name: "OpenAI Compatible",
        description:
          "Connect to an OpenAI compatible TTS service running locally or remotely.",
      },
    },
    fields: {
      apiKey: "API Key",
      baseUrl: "Base URL",
      ttsModel: "TTS Model",
      voiceModel: "Voice Model",
      voiceModelSelection: "Voice Model Selection",
    },
    toasts: {
      sttSaved: "Speech-to-text preferences saved successfully.",
      sttSaveFailed: "Failed to save preferences: {{error}}",
      ttsSaved: "Text-to-speech preferences saved successfully.",
      ttsSaveFailed: "Failed to save preferences: {{error}}",
    },
    piper: {
      description:
        "All PiperTTS models will run in your browser locally. This can be resource intensive on lower-end devices.",
      storedModelHint:
        'The "✔" indicates this model is already stored locally and does not need to be downloaded when run.',
      flushCache: "Flush voice cache",
      stopDemo: "Stop demo",
      loadingVoice: "Loading voice",
      playSample: "Play sample",
      toasts: {
        flushed: "All voices flushed from browser storage",
      },
    },
    openaiCompatible: {
      baseUrlHint:
        "This should be the base URL of the OpenAI compatible TTS service you will generate TTS responses from.",
      apiKeyHint:
        "Some TTS services require an API key to generate TTS responses - this is optional if your service does not require one.",
      ttsPlaceholder: "Your TTS model identifier",
      voicePlaceholder: "Your voice model identifier",
      ttsModelHintStart:
        "Most TTS services will have several models available. This is the",
      ttsModelHintEnd:
        "parameter you will use to select the model you want to use. Note: This is not the same as the voice model.",
      voiceModelHint:
        "Most TTS services will have several voice models available, this is the identifier for the voice model you want to use.",
    },
  },
  "default-system-prompt": {
    title: "Default System Prompt",
    description:
      "This is the default system prompt that will be used for new workspaces.",
    form: {
      label: "System Prompt",
      helpStart:
        "A system prompt provides instructions that shape the AI's responses and behavior. This prompt will be automatically applied to all newly created workspaces. To change the system prompt of a",
      helpStartSeparator: " ",
      specificWorkspace: "specific workspace",
      helpMiddle: ", edit the prompt in the",
      helpMiddleSeparator: " ",
      workspaceSettings: "workspace settings",
      helpEnd:
        ". To restore the system prompt to our sane default, leave this field empty and save changes.",
      variablesPrefix: "You can insert",
      variablesLink: "system prompt variables",
      variablesLike: "like:",
      moreVariables: "+{{count}} more...",
      placeholder:
        "You are an AI assistant that can answer questions and help with tasks.",
      syncExisting: "Sync to existing default workspaces",
      syncExistingHint:
        "Only updates workspaces still using the old default prompt. Custom workspace prompts are not overwritten.",
    },
    toasts: {
      updated: "Default system prompt updated successfully.",
      updatedWithSync:
        "Default system prompt updated successfully. Synced {{synced}} workspaces, skipped {{skipped}} custom workspaces, failed {{failed}}.",
      updateFailed: "Failed to update default system prompt: {{error}}",
    },
  },
  general: {
    vector: {
      title: "Vector Count",
      description: "Total number of vectors in your vector database.",
    },
    names: {
      description: "This will only change the display name of your workspace.",
    },
    message: {
      title: "Suggested Chat Messages",
      description:
        "Customize the messages that will be suggested to your workspace users.",
      add: "Add new message",
      save: "Save Messages",
      heading: "Explain to me",
      body: "the benefits of Athena",
    },
    delete: {
      title: "Delete Workspace",
      description:
        "Delete this workspace and all of its data. This will delete the workspace for all users.",
      delete: "Delete Workspace",
      deleting: "Deleting Workspace...",
      "confirm-start": "You are about to delete your entire",
      "confirm-end":
        "workspace. This will remove all vector embeddings in your vector database.\n\nThe original source files will remain untouched. This action is irreversible.",
    },
  },
  chat: {
    llm: {
      title: "Workspace LLM Provider",
      description:
        "The specific LLM provider & model that will be used for this workspace. By default, it uses the system LLM provider and settings.",
      search: "Search all LLM providers",
    },
    model: {
      title: "Workspace Chat model",
      description:
        "The specific chat model that will be used for this workspace. If empty, will use the system LLM preference.",
    },
    mode: {
      title: "Chat mode",
      automatic: {
        title: "Agent",
        description:
          "will automatically use tools if the model and provider support native tool calling.<br />If native tooling is not supported, you will need to use the @agent command to use tools.",
      },
      chat: {
        title: "Chat",
        description:
          "will provide answers with the LLM's general knowledge <b>and</b> document context that is found.<br />You will need to use the @agent command to use tools.",
      },
      query: {
        title: "Query",
        description:
          "will provide answers <b>only</b> if document context is found.<br />You will need to use the @agent command to use tools.",
      },
    },
    history: {
      title: "Chat History",
      "desc-start":
        "The number of previous chats that will be included in the response's short-term memory.",
      recommend: "Recommend 20. ",
      "desc-end":
        "Anything more than 45 is likely to lead to continuous chat failures depending on message size.",
    },
    prompt: {
      title: "System Prompt",
      description:
        "The prompt that will be used on this workspace. Define the context and instructions for the AI to generate a response. You should provide a carefully crafted prompt so the AI can generate a relevant and accurate response.",
      history: {
        title: "System Prompt History",
        clearAll: "Clear All",
        noHistory: "No system prompt history available",
        restore: "Restore",
        delete: "Delete",
        publish: "Publish to Community Hub",
        deleteConfirm: "Are you sure you want to delete this history item?",
        clearAllConfirm:
          "Are you sure you want to clear all history? This action cannot be undone.",
        expand: "Expand",
      },
    },
    refusal: {
      title: "Query mode refusal response",
      "desc-start": "When in",
      query: "query",
      "desc-end":
        "mode, you may want to return a custom refusal response when no context is found.",
      "tooltip-title": "Why am I seeing this?",
      "tooltip-description":
        "You are in query mode, which only uses information from your documents. Switch to chat mode for more flexible conversations, or click here to visit our documentation to learn more about chat modes.",
    },
    temperature: {
      title: "LLM Temperature",
      "desc-start":
        'This setting controls how "creative" your LLM responses will be.',
      "desc-end":
        "The higher the number the more creative. For some models this can lead to incoherent responses when set too high.",
      hint: "Most LLMs have various acceptable ranges of valid values. Consult your LLM provider for that information.",
    },
  },
  "vector-workspace": {
    identifier: "Vector database identifier",
    snippets: {
      title: "Max Context Snippets",
      description:
        "This setting controls the maximum amount of context snippets that will be sent to the LLM for per chat or query.",
      recommend: "Recommended: 4",
    },
    doc: {
      title: "Document similarity threshold",
      description:
        "The minimum similarity score required for a source to be considered related to the chat. The higher the number, the more similar the source must be to the chat.",
      zero: "No restriction",
      low: "Low (similarity score ≥ .25)",
      medium: "Medium (similarity score ≥ .50)",
      high: "High (similarity score ≥ .75)",
    },
    reset: {
      reset: "Reset Vector Database",
      resetting: "Clearing vectors...",
      confirm:
        "You are about to reset this workspace's vector database. This will remove all vector embeddings currently embedded.\n\nThe original source files will remain untouched. This action is irreversible.",
      error: "Workspace vector database could not be reset!",
      success: "Workspace vector database was reset!",
    },
  },
  agent: {
    "performance-warning":
      "Performance of LLMs that do not explicitly support tool-calling is highly dependent on the model's capabilities and accuracy. Some abilities may be limited or non-functional.",
    provider: {
      title: "Workspace Agent LLM Provider",
      description:
        "The specific LLM provider & model that will be used for this workspace's @agent agent.",
    },
    mode: {
      chat: {
        title: "Workspace Agent Chat model",
        description:
          "The specific chat model that will be used for this workspace's @agent agent.",
      },
      title: "Workspace Agent model",
      description:
        "The specific LLM model that will be used for this workspace's @agent agent.",
      wait: "-- waiting for models --",
    },
    skill: {
      rag: {
        title: "RAG & long-term memory",
        description:
          'Allow the agent to leverage your local documents to answer a query or ask the agent to "remember" pieces of content for long-term memory retrieval.',
      },
      ingest: {
        title: "Document ingest",
        description:
          "Allow the agent to add already uploaded or parsed documents to the current workspace knowledge base.",
      },
      view: {
        title: "View & summarize documents",
        description:
          "Allow the agent to list and summarize the content of workspace files currently embedded.",
      },
      scrape: {
        title: "Scrape websites",
        description:
          "Allow the agent to visit and scrape the content of websites.",
      },
      generate: {
        title: "Generate charts",
        description:
          "Enable the default agent to generate various types of charts from data provided or given in chat.",
      },
      web: {
        title: "Web Search",
        description:
          "Enable your agent to search the web to answer your questions by connecting to a web-search (SERP) provider.",
      },
      sql: {
        title: "SQL Connector",
        description:
          "Enable your agent to be able to leverage SQL to answer you questions by connecting to various SQL database providers.",
      },
      filesystem: {
        title: "File System Access",
        description:
          "Enable your agent to read, write, search, and manage files within a designated directory. Supports file editing, directory navigation, and content search.",
        learnMore: "Learn more about this how to use this skill",
        configuration: "Configuration",
        readActions: "Read Actions",
        writeActions: "Write Actions",
        warning:
          "Filesystem access can be dangerous as it can modify or delete files. Please consult the <a>documentation</a> before enabling.",
        skills: {
          "read-text-file": {
            title: "Read File",
            description:
              "Read contents of files (text, code, PDF, images, etc.)",
          },
          "read-multiple-files": {
            title: "Read Multiple Files",
            description: "Read multiple files at once",
          },
          "list-directory": {
            title: "List Directory",
            description: "List files and directories in a folder",
          },
          "search-files": {
            title: "Search Files",
            description: "Search for files by name or content",
          },
          "get-file-info": {
            title: "Get File Info",
            description: "Get detailed metadata about files",
          },
          "write-text-file": {
            title: "Write Text File",
            description:
              "Create new text files or overwrite existing text files",
          },
          "edit-file": {
            title: "Edit File",
            description: "Make line-based edits to text files",
          },
          "create-directory": {
            title: "Create Directory",
            description: "Create new directories",
          },
          "copy-file": {
            title: "Copy File",
            description: "Copy files and directories",
          },
          "move-file": {
            title: "Move/Rename File",
            description: "Move or rename files and directories",
          },
        },
      },
      createFiles: {
        title: "Document Creation",
        description:
          "Enable your agent to create binary document formats like PowerPoint presentations, Excel spreadsheets, Word documents, and PDFs. Files can be downloaded directly from the chat window.",
        configuration: "Available Document Types",
        skills: {
          "create-text-file": {
            title: "Text Files",
            description:
              "Create text files with any content and extension (.txt, .md, .json, .csv, etc.)",
          },
          "create-pptx": {
            title: "PowerPoint Presentations",
            description:
              "Create new PowerPoint presentations with slides, titles, and bullet points",
          },
          "create-pdf": {
            title: "PDF Documents",
            description:
              "Create PDF documents from markdown or plain text with basic styling",
          },
          "create-xlsx": {
            title: "Excel Spreadsheets",
            description:
              "Create Excel documents for tabular data with sheets and styling",
          },
          "create-docx": {
            title: "Word Documents",
            description:
              "Create Word documents with basic styling and formatting",
          },
        },
      },
      gmail: {
        title: "GMail",
        description:
          "Enable your agent to interact with Gmail - search emails, read threads, compose drafts, send emails, and manage your inbox. <a>Read the documentation</a>.",
        multiUserWarning:
          "Gmail integration is not available in multi-user mode for security reasons. Please disable multi-user mode to use this feature.",
        configuration: "Gmail Configuration",
        deploymentId: "Deployment ID",
        deploymentIdHelp:
          "The deployment ID from your Google Apps Script web app",
        apiKey: "API Key",
        apiKeyHelp:
          "The API key you configured in your Google Apps Script deployment",
        configurationRequired:
          "Please configure the Deployment ID and API Key to enable Gmail skills.",
        configured: "Configured",
        searchSkills: "Search skills...",
        noSkillsFound: "No skills match your search.",
        categories: {
          search: {
            title: "Search & Read Emails",
            description: "Search and read emails from your Gmail inbox",
          },
          drafts: {
            title: "Draft Emails",
            description: "Create, edit, and manage email drafts",
          },
          send: {
            title: "Send & Reply to Emails",
            description: "Send emails and reply to threads immediately",
          },
          threads: {
            title: "Manage Email Threads",
            description:
              "Manage email threads - mark read/unread, archive, trash",
          },
          account: {
            title: "Integration Statistics",
            description: "View mailbox statistics and account information",
          },
        },
        skills: {
          getInbox: {
            title: "Get Inbox",
            description: "Streamlined way to get the inbox emails from Gmail",
          },
          search: {
            title: "Search Emails",
            description: "Search emails using Gmail query syntax",
          },
          readThread: {
            title: "Read Thread",
            description: "Read a full email thread by ID",
          },
          createDraft: {
            title: "Create Draft",
            description: "Create a new draft email",
          },
          createDraftReply: {
            title: "Create Draft Reply",
            description: "Create a draft reply to an existing thread",
          },
          updateDraft: {
            title: "Update Draft",
            description: "Update an existing draft email",
          },
          getDraft: {
            title: "Get Draft",
            description: "Retrieve a specific draft by ID",
          },
          listDrafts: {
            title: "List Drafts",
            description: "List all draft emails",
          },
          deleteDraft: {
            title: "Delete Draft",
            description: "Delete a draft email",
          },
          sendDraft: {
            title: "Send Draft",
            description: "Send an existing draft email",
          },
          sendEmail: {
            title: "Send Email",
            description: "Send an email immediately",
          },
          replyToThread: {
            title: "Reply to Thread",
            description: "Reply to an email thread immediately",
          },
          markRead: {
            title: "Mark Read",
            description: "Mark a thread as read",
          },
          markUnread: {
            title: "Mark Unread",
            description: "Mark a thread as unread",
          },
          moveToTrash: {
            title: "Move to Trash",
            description: "Move a thread to trash",
          },
          moveToArchive: {
            title: "Archive",
            description: "Archive a thread",
          },
          moveToInbox: {
            title: "Move to Inbox",
            description: "Move a thread to inbox",
          },
          getMailboxStats: {
            title: "Mailbox Stats",
            description: "Get unread counts and mailbox statistics",
          },
        },
      },
      googleCalendar: {
        title: "Google Calendar",
        description:
          "Enable your agent to interact with Google Calendar - view calendars, get events, create and update events, and manage RSVPs. <a>Read the documentation</a>.",
        multiUserWarning:
          "Google Calendar integration is not available in multi-user mode for security reasons. Please disable multi-user mode to use this feature.",
        configuration: "Google Calendar Configuration",
        deploymentId: "Deployment ID",
        deploymentIdHelp:
          "The deployment ID from your Google Apps Script web app",
        apiKey: "API Key",
        apiKeyHelp:
          "The API key you configured in your Google Apps Script deployment",
        configurationRequired:
          "Please configure the Deployment ID and API Key to enable Google Calendar skills.",
        configured: "Configured",
        searchSkills: "Search skills...",
        noSkillsFound: "No skills match your search.",
        categories: {
          calendars: {
            title: "Calendars",
            description: "View and manage your Google Calendars",
          },
          readEvents: {
            title: "Read Events",
            description: "View and search calendar events",
          },
          writeEvents: {
            title: "Create & Update Events",
            description: "Create new events and modify existing ones",
          },
          rsvp: {
            title: "RSVP Management",
            description: "Manage your response status for events",
          },
        },
        skills: {
          listCalendars: {
            title: "List Calendars",
            description: "List all calendars you own or are subscribed to",
          },
          getCalendar: {
            title: "Get Calendar Details",
            description: "Get detailed information about a specific calendar",
          },
          getEvent: {
            title: "Get Event",
            description: "Get detailed information about a specific event",
          },
          getEventsForDay: {
            title: "Get Events for Day",
            description: "Get all events scheduled for a specific day",
          },
          getEvents: {
            title: "Get Events (Date Range)",
            description: "Get events within a custom date range",
          },
          getUpcomingEvents: {
            title: "Get Upcoming Events",
            description:
              "Get events for today, this week, or this month using simple keywords",
          },
          quickAdd: {
            title: "Quick Add Event",
            description:
              "Create an event from natural language (e.g., 'Meeting tomorrow at 3pm')",
          },
          createEvent: {
            title: "Create Event",
            description:
              "Create a new event with full control over all properties",
          },
          updateEvent: {
            title: "Update Event",
            description: "Update an existing calendar event",
          },
          setMyStatus: {
            title: "Set RSVP Status",
            description: "Accept, decline, or tentatively accept an event",
          },
        },
      },
      outlook: {
        title: "Outlook",
        description:
          "Enable your agent to interact with Microsoft Outlook - search emails, read threads, compose drafts, send emails, and manage your inbox via Microsoft Graph API. <a>Read the documentation</a>.",
        multiUserWarning:
          "Outlook integration is not available in multi-user mode for security reasons. Please disable multi-user mode to use this feature.",
        configuration: "Outlook Configuration",
        authType: "Account Type",
        authTypeHelp:
          "Choose which types of Microsoft accounts can authenticate. 'All accounts' supports both personal and work/school accounts. 'Personal only' restricts to personal Microsoft accounts. 'Organization only' restricts to work/school accounts from a specific Azure AD tenant.",
        authTypeCommon: "All accounts (personal & work/school)",
        authTypeConsumers: "Personal Microsoft accounts only",
        authTypeOrganization: "Organization accounts only (requires Tenant ID)",
        clientId: "Application (Client) ID",
        clientIdHelp:
          "The Application (Client) ID from your Azure AD app registration",
        tenantId: "Directory (Tenant) ID",
        tenantIdHelp:
          "The Directory (Tenant) ID from your Azure AD app registration. Required only for organization-only authentication.",
        clientSecret: "Client Secret",
        clientSecretHelp:
          "The client secret value from your Azure AD app registration",
        configurationRequired:
          "Please configure the Client ID and Client Secret to enable Outlook skills.",
        authRequired:
          "Save your credentials first, then authenticate with Microsoft to complete the setup.",
        authenticateWithMicrosoft: "Authenticate with Microsoft",
        authenticated: "Successfully authenticated with Microsoft Outlook.",
        revokeAccess: "Revoke Access",
        configured: "Configured",
        searchSkills: "Search skills...",
        noSkillsFound: "No skills match your search.",
        categories: {
          search: {
            title: "Search & Read Emails",
            description: "Search and read emails from your Outlook inbox",
          },
          drafts: {
            title: "Draft Emails",
            description: "Create, edit, and manage email drafts",
          },
          send: {
            title: "Send Emails",
            description: "Send new emails or reply to messages immediately",
          },
          account: {
            title: "Integration Statistics",
            description: "View mailbox statistics and account information",
          },
        },
        skills: {
          getInbox: {
            title: "Get Inbox",
            description: "Get recent emails from your Outlook inbox",
          },
          search: {
            title: "Search Emails",
            description: "Search emails using Microsoft Search syntax",
          },
          readThread: {
            title: "Read Conversation",
            description: "Read a full email conversation thread",
          },
          createDraft: {
            title: "Create Draft",
            description:
              "Create a new draft email or draft reply to an existing message",
          },
          updateDraft: {
            title: "Update Draft",
            description: "Update an existing draft email",
          },
          listDrafts: {
            title: "List Drafts",
            description: "List all draft emails",
          },
          deleteDraft: {
            title: "Delete Draft",
            description: "Delete a draft email",
          },
          sendDraft: {
            title: "Send Draft",
            description: "Send an existing draft email",
          },
          sendEmail: {
            title: "Send Email",
            description:
              "Send a new email or reply to an existing message immediately",
          },
          getMailboxStats: {
            title: "Mailbox Stats",
            description: "Get folder counts and mailbox statistics",
          },
        },
      },
      default_skill:
        "By default, this skill is enabled, but you can disable it if you don't want it to be available to the agent.",
    },
    mcp: {
      title: "MCP Servers",
      "loading-from-config": "Loading MCP Servers from configuration file",
      "learn-more": "Learn more about MCP Servers.",
      "no-servers-found": "No MCP servers found",
      "tool-warning":
        "For the best performance, consider disabling unwanted tools to conserve context.",
      "tools-enabled": "tools enabled",
      "stop-server": "Stop MCP Server",
      "start-server": "Start MCP Server",
      "delete-server": "Delete MCP Server",
      "tool-count-warning":
        "This MCP server has <b>{{count}} tools enabled</b> that will consume context in every chat.<br />Consider disabling unwanted tools to conserve context.",
      "startup-command": "Startup Command",
      command: "Command",
      arguments: "Arguments",
      "not-running-warning":
        "This MCP server is not running - it may be stopped or experiencing an error on startup.",
      "tool-call-arguments": "Tool call arguments",
    },
    settings: {
      title: "Agent Skill Settings",
      "max-tool-calls": {
        title: "Max Tool Calls Per Response",
        description:
          "The maximum number of tools an agent can chain to generate a single response. This prevents runaway tool calls and infinite loops.",
      },
      "intelligent-skill-selection": {
        title: "Intelligent Skill Selection",
        "beta-badge": "Beta",
        description:
          "Enable unlimited tools and cut token usage by up to 80% per query — Athena automatically selects the right skills for every prompt.",
        "max-tools": {
          title: "Max Tools",
          description:
            "The maximum number of tools to select for each query. We recommend setting this to higher values for larger context models.",
        },
      },
    },
  },
  recorded: {
    title: "Workspace Chats",
    description:
      "These are all the recorded chats and messages that have been sent by users ordered by their creation date.",
    export: "Export",
    table: {
      id: "ID",
      by: "Sent By",
      workspace: "Workspace",
      prompt: "Prompt",
      response: "Response",
      at: "Sent At",
    },
  },
  customization: {
    interface: {
      title: "UI Preferences",
      description: "Set your UI preferences for Athena.",
    },
    branding: {
      title: "Branding & Whitelabeling",
      description: "White-label your Athena instance with custom branding.",
    },
    chat: {
      title: "Chat",
      description: "Set your chat preferences for Athena.",
      auto_submit: {
        title: "Auto-Submit Speech Input",
        description:
          "Automatically submit speech input after a period of silence",
      },
      auto_speak: {
        title: "Auto-Speak Responses",
        description: "Automatically speak responses from the AI",
      },
      spellcheck: {
        title: "Enable Spellcheck",
        description: "Enable or disable spellcheck in the chat input field",
      },
    },
    items: {
      theme: {
        title: "Theme",
        description: "Select your preferred color theme for the application.",
        options: {
          system: "System",
          light: "Light",
          dark: "Dark",
        },
      },
      "motion-density": {
        title: "Motion density",
        description:
          "Controls animation strength and pacing across route, panel, modal, and micro interactions.",
        guide: {
          title: "Speed guide",
          description:
            "The moving dot previews the rhythm: shorter travel feels calmer and faster, longer travel feels fuller and more visible.",
        },
        options: {
          minimal: {
            label: "Minimal",
            description:
              "Shorter, calmer motion for the most restrained interface.",
            speed: "Fast and restrained",
            duration: "about 0.28s",
          },
          balanced: {
            label: "Balanced",
            description:
              "The default product rhythm: polished, stable, and quiet.",
            speed: "Standard rhythm",
            duration: "about 0.36s",
          },
          expressive: {
            label: "Expressive",
            description:
              "Slightly fuller motion while staying within performance budgets.",
            speed: "Slower and fuller",
            duration: "about 0.48s",
          },
        },
      },
      "show-scrollbar": {
        title: "Show Scrollbar",
        description: "Enable or disable the scrollbar in the chat window.",
      },
      "support-email": {
        title: "Support Email",
        description:
          "Set the support email address that should be accessible by users when they need help.",
      },
      "app-name": {
        title: "Name",
        description:
          "Set a name that is displayed on the login page to all users.",
      },
      "display-language": {
        title: "Display Language",
        description:
          "Select the preferred language to render Athena's UI in - when translations are available.",
      },
      logo: {
        title: "Brand Logo",
        description: "Upload your custom logo to showcase on all pages.",
        add: "Add a custom logo",
        recommended: "Recommended size: 800 x 200",
        remove: "Remove",
        replace: "Replace",
      },
      "browser-appearance": {
        title: "Browser Appearance",
        description:
          "Customize the appearance of the browser tab and title when the app is open.",
        tab: {
          title: "Title",
          description:
            "Set a custom tab title when the app is open in a browser.",
        },
        favicon: {
          title: "Favicon",
          description: "Use a custom favicon for the browser tab.",
        },
      },
      "sidebar-footer": {
        title: "Sidebar Footer Items",
        description:
          "Customize the footer items displayed on the bottom of the sidebar.",
        icon: "Icon",
        link: "Link",
      },
      "render-html": {
        title: "Render HTML in chat",
        description:
          "Render HTML responses in assistant responses.\nThis can result in a much higher fidelity of response quality, but can also lead to potential security risks.",
      },
    },
  },
  api: {
    title: "API Keys",
    description:
      "API keys allow the holder to programmatically access and manage this Athena instance.",
    link: "Read the API documentation",
    generate: "Generate New API Key",
    empty: "No API keys found",
    actions: "Actions",
    messages: {
      error: "Error: {{error}}",
    },
    modal: {
      title: "Create new API key",
      cancel: "Cancel",
      close: "Close",
      create: "Create API Key",
      helper:
        "Once created the API key can be used to programmatically access and configure this Athena instance.",
      name: {
        label: "Name",
        placeholder: "Production integration",
        helper:
          "Optional. Use a friendly name so you can identify this key later.",
      },
    },
    row: {
      copy: "Copy API Key",
      copied: "Copied",
      unnamed: "--",
      deleteConfirm:
        "Are you sure you want to deactivate this api key?\nAfter you do this it will not longer be useable.\n\nThis action is irreversible.",
    },
    table: {
      name: "Name",
      key: "API Key",
      by: "Created By",
      created: "Created",
    },
  },
  rerank: {
    title: "Rerank Model Preference",
    description:
      "Configure the provider and model used to rerank vector search results. When a workspace uses accuracy optimized retrieval, these rerank settings are applied.",
    provider: "Rerank Provider",
    providerHint:
      "Use the built-in reranker by default. Select Alibaba Cloud DashScope only after you have a DashScope API key and want hosted qwen3 rerank.",
    providers: {
      native: {
        name: "Built-in Reranker",
        description:
          "Use the local system reranker included with Athena. No API key or hosted endpoint is required.",
      },
      alibaba: {
        name: "Alibaba DashScope",
        description:
          "Use Alibaba Cloud DashScope qwen3 rerank to reorder vector search results.",
      },
    },
    model: "Rerank Model",
    nativeHelp:
      "The built-in reranker runs locally through the system native rerank model, so API Key, Base URL, and model fields are not needed. This is the default mode before Alibaba DashScope rerank is configured.",
    help: "Alibaba DashScope rerank sends vector-search candidates to the DashScope rerank endpoint and reorders them by query relevance. Provide your DashScope API Key, Base URL, and model name.",
    save: "Save changes",
    saving: "Saving...",
  },
  ocr: {
    title: "OCR Model Preference",
    description:
      "Configure the provider and model the reader uses to recognize text from scanned PDFs and images.",
    provider: "OCR Provider",
    providerHint:
      "Hosted OCR is disabled by default. Select Alibaba Cloud DashScope only after you have a DashScope API key and want Alibaba OCR for scanned text.",
    providers: {
      none: {
        name: "None",
        description:
          "Do not use a hosted OCR model. Scanned documents will not automatically call external OCR.",
      },
      alibaba: {
        name: "Alibaba DashScope",
        description:
          "Use Alibaba Cloud DashScope qwen-vl-ocr to recognize image and scanned text.",
      },
    },
    model: "OCR Model",
    noneHelp:
      "No hosted OCR model will be called. The reader can still use existing text layers and local parse results, but scanned PDF or image OCR post-processing remains unconfigured.",
    help: "Alibaba DashScope OCR sends image content that needs recognition to the DashScope OpenAI-compatible endpoint. Provide your DashScope API Key, Base URL, and model name.",
    save: "Save changes",
    saving: "Saving...",
    saved: "OCR model settings saved.",
    saveError: "Failed to save OCR model settings: {{error}}",
  },
  vision: {
    title: "Vision Model Preference",
    description:
      "Configure the provider and model used for hosted visual understanding tasks.",
    provider: "Vision Provider",
    providerHint:
      "Hosted vision is disabled by default. Select Alibaba Cloud DashScope only after you have a DashScope API key and want to configure a vision model.",
    providers: {
      none: {
        name: "None",
        description:
          "Do not use a hosted vision model. Visual understanding calls remain unconfigured.",
      },
      alibaba: {
        name: "Alibaba DashScope",
        description:
          "Use Alibaba Cloud DashScope Qwen VL models for visual understanding.",
      },
    },
    model: "Vision Model",
    noneHelp:
      "No hosted vision model is configured. This only controls the global vision model preference and does not change OCR or chat behavior by itself.",
    help: "Alibaba DashScope vision uses the OpenAI-compatible endpoint. Provide your DashScope API Key, Base URL, and model name.",
    toolToggle: {
      label: "Enable image pre-analysis",
      description:
        "When chat messages include images, analyze them first with the vision model and send the analysis to the main chat model.",
      disabledDescription:
        "This can stay on, but image pre-analysis only runs after Alibaba DashScope is configured.",
    },
    save: "Save changes",
    saving: "Saving...",
    saved: "Vision model settings saved.",
    saveError: "Failed to save vision model settings: {{error}}",
  },
  llm: {
    title: "LLM Preference",
    description:
      "These are the credentials and settings for your preferred LLM chat & embedding provider. It is important that these keys are current and correct, or else Athena will not function properly.",
    provider: "LLM Provider",
    providers: {
      azure_openai: {
        azure_service_endpoint: "Azure Service Endpoint",
        api_key: "API Key",
        chat_deployment_name: "Chat Deployment Name",
        chat_model_token_limit: "Chat Model Token Limit",
        model_type: "Model Type",
        model_type_tooltip:
          "If your deployment uses a reasoning model (o1, o1-mini, o3-mini, etc.), set this to “Reasoning”. Otherwise, your chat requests may fail.",
        default: "Default",
        reasoning: "Reasoning",
      },
    },
  },
  provider_preset: {
    title: "Preset Code Import",
    placeholder: "Enter preset code",
    apply: "Apply configuration",
    applying: "Applying...",
    imported_status: "Imported from environment variables",
    success_toast:
      "Applied DeepSeek V4 Pro + Ali text-embedding-v4 + Ali OCR + Ali vision configuration",
  },
  transcription: {
    title: "Transcription Model Preference",
    description:
      "These are the credentials and settings for your preferred transcription model provider. Its important these keys are current and correct or else media files and audio will not transcribe.",
    provider: "Transcription Provider",
    "warn-start":
      "Using the local whisper model on machines with limited RAM or CPU can stall Athena when processing media files.",
    "warn-recommend":
      "We recommend at least 2GB of RAM and upload files <10Mb.",
    "warn-end":
      "The built-in model will automatically download on the first use.",
  },
  embedding: {
    title: "Vector Engine",
    "desc-start":
      "Athena Vector Engine turns documents, conversations, and knowledge into semantic vectors for retrieval.",
    "desc-end":
      "Configure the embedding provider that powers indexing, semantic search, and retrieval across Athena.",
    provider: {
      title: "Vector Engine Provider",
    },
    "document-mode": {
      title: "Document Embedding Mode",
      direct: {
        title: "Direct real-time",
        description:
          "Files are embedded immediately after upload. This is faster but billed at real-time embedding rates.",
      },
      batch: {
        title: "Batch async",
        description:
          "Files are submitted as asynchronous batch jobs. Cost is lower, but documents are searchable only after completion.",
      },
      note: "This setting only affects document ingestion and workspace embedding rebuilds. Athena Search and RAG queries always use direct real-time embeddings.",
    },
  },
  "batch-jobs": {
    title: "Batch Jobs",
    description: "Review asynchronous document embedding jobs.",
    table: {
      "job-id": "Job ID",
      workspace: "Workspace",
      status: "Status",
      graph: "Knowledge Graph",
      "retry-count": "Retries",
      "next-retry": "Next Retry",
      created: "Created",
      updated: "Updated",
      error: "Last Error",
      action: "Action",
    },
    retry: {
      label: "Retry",
      working: "Retrying...",
      started: "Batch job polling resumed.",
      failed: "Failed to resume batch job polling.",
    },
    graph: {
      status: {
        not_started: "Not started",
        pending: "Pending",
        processing: "Processing",
        completed: "Completed",
        partial_failed: "Partial failed",
        failed: "Failed",
        unknown: "Unknown",
      },
    },
  },
  text: {
    title: "Text splitting & Chunking Preferences",
    "desc-start":
      "Sometimes, you may want to change the default way that new documents are split and chunked before being inserted into your vector database.",
    "desc-end":
      "You should only modify this setting if you understand how text splitting works and it's side effects.",
    size: {
      title: "Text Chunk Size",
      description:
        "This is the maximum length of characters that can be present in a single vector.",
      recommend: "Embed model maximum length is",
    },
    overlap: {
      title: "Text Chunk Overlap",
      description:
        "This is the maximum overlap of characters that occurs during chunking between two adjacent text chunks.",
    },
  },
  vector: {
    title: "Vector Engine Storage",
    description:
      "Configure where Athena Vector Engine stores semantic vectors for retrieval and reasoning.",
    provider: {
      title: "Vector Storage Provider",
      description: "There is no configuration needed for LanceDB.",
    },
  },
  embeddable: {
    title: "Embeddable Chat Widgets",
    description:
      "Embeddable chat widgets are public facing chat interfaces that are tied to a single workspace. These allow you to build workspaces that then you can publish to the world.",
    create: "Create embed",
    table: {
      workspace: "Workspace",
      chats: "Sent Chats",
      active: "Active Domains",
      created: "Created",
    },
  },
  "embed-chats": {
    title: "Embed Chat History",
    export: "Export",
    description:
      "These are all the recorded chats and messages from any embed that you have published.",
    table: {
      embed: "Embed",
      sender: "Sender",
      message: "Message",
      response: "Response",
      at: "Sent At",
    },
  },
  telegram: {
    title: "Telegram Bot",
    description:
      "Connect your Athena instance to Telegram so you can chat with your workspaces from any device.",
    setup: {
      step1: {
        title: "Step 1: Create your Telegram bot",
        description:
          "Open @BotFather in Telegram, send <code>/newbot</code> to <code>@BotFather</code>, follow the prompts, and copy the API token.",
        "open-botfather": "Open BotFather",
        "instruction-1": "1. Open the link or scan the QR code",
        "instruction-2":
          "2. Send <code>/newbot</code> to <code>@BotFather</code>",
        "instruction-3": "3. Choose a name and username for your bot",
        "instruction-4": "4. Copy the API token you receive",
      },
      step2: {
        title: "Step 2: Connect your bot",
        description:
          "Paste the API token you received from @BotFather to connect your bot.",
        "bot-token": "Bot Token",
        connecting: "Connecting...",
        "connect-bot": "Connect Bot",
      },
      security: {
        title: "Recommended Security Settings",
        description:
          "For additional security, configure these settings in @BotFather.",
        "disable-groups": "— Prevent adding bot to groups",
        "disable-inline": "— Prevent bot from being used in inline search",
        "obscure-username":
          "Use a non-obvious bot handle username to reduce discoverability",
      },
      "toast-enter-token": "Please enter a bot token.",
      "toast-connect-failed": "Failed to connect bot.",
    },
    connected: {
      status: "Connected",
      "status-disconnected": "Disconnected — token may be expired or invalid",
      "placeholder-token": "Paste new bot token...",
      reconnect: "Reconnect",
      workspace: "Workspace",
      "bot-link": "Bot Link",
      "voice-response": "Voice Response",
      disconnecting: "Disconnecting...",
      disconnect: "Disconnect",
      "voice-text-only": "Text only",
      "voice-mirror": "Mirror (reply with voice when user sends voice)",
      "voice-always": "Always voice (send audio with every reply)",
      "toast-disconnect-failed": "Failed to disconnect bot.",
      "toast-reconnect-failed": "Failed to reconnect bot.",
      "toast-voice-failed": "Failed to update voice mode.",
      "toast-approve-failed": "Failed to approve user.",
      "toast-deny-failed": "Failed to deny user.",
      "toast-revoke-failed": "Failed to revoke user.",
    },
    users: {
      "pending-description":
        "Users waiting to be verified. Match the pairing code shown here with the one displayed in their Telegram chat.",
      unknown: "Unknown",
    },
  },
  wechat: {
    title: "WeChat Connector",
    description:
      "Connect WeChat by scanning the official Tencent OpenClaw Weixin QR code.",
    enabled: {
      title: "Enable WeChat Connector",
      description:
        "Allow this Athena instance to use the WeChat connector when an official bridge is configured.",
    },
    qr: {
      placeholder: "Generate a QR code and scan it with WeChat to connect.",
      generate: "Generate/Refresh QR Code",
      alt: "WeChat login QR code",
      "open-link-helper":
        "If the QR code cannot be scanned, open this link in your browser.",
    },
    status: {
      title: "Login Status",
      disconnected: "Disconnected",
      pending_scan: "Waiting for scan",
      connected: "Connected",
      expired: "Expired",
      "connected-hint":
        "Connected. Disconnect first if you need to scan a new QR code.",
      "disconnecting-hint":
        "Disconnecting and cleaning up the OpenClaw login session...",
    },
    profile: {
      title: "WeChat User",
      avatar: "WeChat avatar",
      nickname: "Nickname",
      wxid: "wxid/openid",
      openid: "openid/account",
      "last-connected": "Last connected",
      placeholder: "Not available",
      "best-effort":
        "Profile fields are read from OpenClaw metadata only; credentials stay on disk with OpenClaw.",
    },
    actions: {
      relogin: "Re-login",
      disconnect: "Disconnect",
      disconnecting: "Disconnecting...",
    },
    toasts: {
      "save-failed": "Failed to save WeChat connector settings.",
      "qr-failed": "Failed to generate QR code.",
      "status-failed": "Failed to refresh WeChat login status.",
      "disconnect-failed": "Failed to disconnect WeChat connector.",
    },
    errors: {
      openclaw_not_installed:
        "OpenClaw CLI was not found. Set OPENCLAW_BIN or install OpenClaw first.",
      plugin_missing: "OpenClaw Weixin plugin is not installed.",
      environment_incomplete:
        "OpenClaw Weixin environment is incomplete or not writable.",
      plugin_install_failed: "Failed to install OpenClaw Weixin plugin.",
      qr_generation_failed: "Failed to generate a WeChat QR code.",
      login_status_failed: "Failed to read WeChat login status.",
      disconnect_failed: "Failed to disconnect OpenClaw Weixin.",
    },
  },
  advancedGateway: {
    title: "Advanced Gateway Connector",
    description:
      "Configure a custom external gateway for Clawbot, Python, Rust, or other message relay services.",
    enabled: {
      title: "Enable Advanced Gateway Connector",
      description:
        "Allow external gateway services to be used after they are implemented.",
    },
    notes: {
      title: "Gateway security notes",
      "api-secret":
        "API Secret is used by external Gateways to generate HMAC signatures for Athena webhooks.",
      "gateway-url":
        "Gateway URL is currently recorded as the address of your external Gateway service.",
      "no-wechat-state":
        "WeChat login state, cookies, tokens, and local credentials are not stored in Athena.",
      "external-gateway":
        "Real WeChat login, message receiving, and message sending are handled by your external Gateway, Clawbot, or OpenClaw WeChat plugin.",
    },
    fields: {
      "gateway-url": "Gateway URL",
      "api-key": "API Key",
      "api-secret": "API Secret",
      "secret-saved": "Saved. Leave blank to keep unchanged.",
    },
    actions: {
      test: "Test Connection",
      save: "Save Config",
    },
    toasts: {
      saved: "Advanced Gateway connector settings saved.",
      tested: "Advanced Gateway connection test complete.",
      "save-failed": "Failed to save Advanced Gateway connector settings.",
      "test-failed": "Failed to test Advanced Gateway connector.",
    },
  },
  security: {
    title: "Security",
    multiuser: {
      title: "Multi-User Mode",
      description:
        "Set up your instance to support your team by activating Multi-User Mode.",
      enable: {
        "is-enable": "Multi-User Mode is Enabled",
        enable: "Enable Multi-User Mode",
        description:
          "By default, you will be the only admin. As an admin you will need to create accounts for all new users or admins. Do not lose your password as only an Admin user can reset passwords.",
        username: "Admin account username",
        password: "Admin account password",
      },
    },
    password: {
      title: "Password Protection",
      description:
        "Protect your Athena instance with a password. If you forget this there is no recovery method so ensure you save this password.",
      "password-label": "Instance Password",
    },
  },
  event: {
    title: "Event Logs",
    description:
      "View all actions and events happening on this instance for monitoring.",
    clear: "Clear Event Logs",
    table: {
      type: "Event Type",
      user: "User",
      occurred: "Occurred At",
    },
  },
  privacy: {
    title: "Privacy & Data-Handling",
    description:
      "This is your configuration for how connected third party providers and Athena handle your data.",
    anonymous: "Anonymous Telemetry Enabled",
  },
  connectors: {
    "search-placeholder": "Search data connectors",
    "no-connectors": "No data connectors found.",
    obsidian: {
      vault_location: "Vault Location",
      vault_description:
        "Select your Obsidian vault folder to import all notes and their connections.",
      selected_files: "Found {{count}} markdown files",
      importing: "Importing vault...",
      import_vault: "Import Vault",
      processing_time:
        "This may take a while depending on the size of your vault.",
      vault_warning:
        "To avoid any conflicts, make sure your Obsidian vault is not currently open.",
    },
    github: {
      name: "GitHub Repo",
      description:
        "Import an entire public or private GitHub repository in a single click.",
      URL: "GitHub Repo URL",
      URL_explained: "Url of the GitHub repo you wish to collect.",
      token: "GitHub Access Token",
      optional: "optional",
      token_explained: "Access Token to prevent rate limiting.",
      token_explained_start: "Without a ",
      token_explained_link1: "Personal Access Token",
      token_explained_middle:
        ", the GitHub API may limit the number of files that can be collected due to rate limits. You can ",
      token_explained_link2: "create a temporary Access Token",
      token_explained_end: " to avoid this issue.",
      ignores: "File Ignores",
      git_ignore:
        "List in .gitignore format to ignore specific files during collection. Press enter after each entry you want to save.",
      task_explained:
        "Once complete, all files will be available for embedding into workspaces in the document picker.",
      branch: "Branch you wish to collect files from.",
      branch_loading: "-- loading available branches --",
      branch_explained: "Branch you wish to collect files from.",
      token_information:
        "Without filling out the <b>GitHub Access Token</b> this data connector will only be able to collect the <b>top-level</b> files of the repo due to GitHub's public API rate-limits.",
      token_personal:
        "Get a free Personal Access Token with a GitHub account here.",
    },
    gitlab: {
      name: "GitLab Repo",
      description:
        "Import an entire public or private GitLab repository in a single click.",
      URL: "GitLab Repo URL",
      URL_explained: "URL of the GitLab repo you wish to collect.",
      token: "GitLab Access Token",
      optional: "optional",
      token_description:
        "Select additional entities to fetch from the GitLab API.",
      token_explained_start: "Without a ",
      token_explained_link1: "Personal Access Token",
      token_explained_middle:
        ", the GitLab API may limit the number of files that can be collected due to rate limits. You can ",
      token_explained_link2: "create a temporary Access Token",
      token_explained_end: " to avoid this issue.",
      fetch_issues: "Fetch Issues as Documents",
      ignores: "File Ignores",
      git_ignore:
        "List in .gitignore format to ignore specific files during collection. Press enter after each entry you want to save.",
      task_explained:
        "Once complete, all files will be available for embedding into workspaces in the document picker.",
      branch: "Branch you wish to collect files from",
      branch_loading: "-- loading available branches --",
      branch_explained: "Branch you wish to collect files from.",
      token_information:
        "Without filling out the <b>GitLab Access Token</b> this data connector will only be able to collect the <b>top-level</b> files of the repo due to GitLab's public API rate-limits.",
      token_personal:
        "Get a free Personal Access Token with a GitLab account here.",
    },
    youtube: {
      name: "YouTube Transcript",
      description:
        "Import the transcription of an entire YouTube video from a link.",
      URL: "YouTube Video URL",
      URL_explained_start:
        "Enter the URL of any YouTube video to fetch its transcript. The video must have ",
      URL_explained_link: "closed captions",
      URL_explained_end: " available.",
      task_explained:
        "Once complete, the transcript will be available for embedding into workspaces in the document picker.",
    },
    "website-depth": {
      name: "Bulk Link Scraper",
      description: "Scrape a website and its sub-links up to a certain depth.",
      URL: "Website URL",
      URL_explained: "URL of the website you want to scrape.",
      depth: "Crawl Depth",
      depth_explained:
        "This is the number of child-links that the worker should follow from the origin URL.",
      max_pages: "Maximum Pages",
      max_pages_explained: "Maximum number of links to scrape.",
      task_explained:
        "Once complete, all scraped content will be available for embedding into workspaces in the document picker.",
    },
    confluence: {
      name: "Confluence",
      description: "Import an entire Confluence page in a single click.",
      deployment_type: "Confluence deployment type",
      deployment_type_explained:
        "Determine if your Confluence instance is hosted on Atlassian cloud or self-hosted.",
      base_url: "Confluence base URL",
      base_url_explained: "This is the base URL of your Confluence space.",
      space_key: "Confluence space key",
      space_key_explained:
        "This is the spaces key of your confluence instance that will be used. Usually begins with ~",
      username: "Confluence Username",
      username_explained: "Your Confluence username",
      auth_type: "Confluence Auth Type",
      auth_type_explained:
        "Select the authentication type you want to use to access your Confluence pages.",
      auth_type_username: "Username and Access Token",
      auth_type_personal: "Personal Access Token",
      token: "Confluence Access Token",
      token_explained_start:
        "You need to provide an access token for authentication. You can generate an access token",
      token_explained_link: "here",
      token_desc: "Access token for authentication",
      pat_token: "Confluence Personal Access Token",
      pat_token_explained: "Your Confluence personal access token.",
      bypass_ssl: "Bypass SSL Certificate Validation",
      bypass_ssl_explained:
        "Enable this option to bypass SSL certificate validation for self-hosted confluence instances with self-signed certificate",
      task_explained:
        "Once complete, the page content will be available for embedding into workspaces in the document picker.",
    },
    manage: {
      documents: "Documents",
      "data-connectors": "Data Connectors",
      "desktop-only":
        "Editing these settings are only available on a desktop device. Please access this page on your desktop to continue.",
      dismiss: "Dismiss",
      editing: "Editing",
    },
    directory: {
      "my-documents": "My Documents",
      "new-folder": "New Folder",
      "create-folder-title": "Create New Folder",
      "folder-name": "Folder Name",
      "folder-name-placeholder": "Enter folder name",
      "cancel-create-folder": "Cancel",
      "create-folder": "Create Folder",
      "creating-folder": "Creating...",
      "create-folder-error": "Failed to create folder.",
      "close-create-folder": "Close create folder dialog",
      "total-documents_one": "{{count}} document",
      "total-documents_other": "{{count}} documents",
      "search-document": "Search for document",
      "no-documents": "No Documents",
      "move-workspace": "Move to Workspace",
      "delete-confirmation":
        "Are you sure you want to delete these files and folders?\nThis will remove the files from the system and remove them from any existing workspaces automatically.\nThis action is not reversible.",
      "removing-message":
        "Removing {{count}} documents and {{folderCount}} folders. Please wait.",
      "move-success": "Successfully moved {{count}} documents.",
      no_docs: "No Documents",
      select_all: "Select All",
      deselect_all: "Deselect All",
      remove_selected: "Remove Selected",
      save_embed: "Save and Embed",
    },
    upload: {
      "processor-offline": "Document Processor Unavailable",
      "processor-offline-desc":
        "We can't upload your files right now because the document processor is offline. Please try again later.",
      "click-upload": "Click to upload or drag and drop",
      "file-types":
        "supports text files, csv's, spreadsheets, audio files, and more!",
      "or-submit-link": "or submit a link",
      "placeholder-link": "https://example.com",
      fetching: "Fetching...",
      "fetch-website": "Fetch website",
      "privacy-notice":
        "These files will be uploaded to the document processor running on this Athena instance. These files are not sent or shared with a third party.",
    },
    pinning: {
      what_pinning: "What is document pinning?",
      pin_explained_block1:
        "When you <b>pin</b> a document in Athena we will inject the entire content of the document into your prompt window for your LLM to fully comprehend.",
      pin_explained_block2:
        "This works best with <b>large-context models</b> or small files that are critical to its knowledge-base.",
      pin_explained_block3:
        "If you are not getting the answers you desire from Athena by default then pinning is a great way to get higher quality answers in a click.",
      accept: "Okay, got it",
    },
    watching: {
      what_watching: "What does watching a document do?",
      watch_explained_block1:
        "When you <b>watch</b> a document in Athena we will <i>automatically</i> sync your document content from it's original source on regular intervals. This will automatically update the content in every workspace where this file is managed.",
      watch_explained_block2:
        "This feature currently supports online-based content and will not be available for manually uploaded documents.",
      watch_explained_block3_start:
        "You can manage what documents are watched from the ",
      watch_explained_block3_link: "File manager",
      watch_explained_block3_end: " admin view.",
      accept: "Okay, got it",
    },
  },
  chat_window: {
    attachments_processing: "Attachments are processing. Please wait...",
    ocr_processing: "OCR recognition is processing. Please wait...",
    send_message: "Send a message",
    attach_file: "Upload or attach a file to this chat.",
    controls: {
      upload: {
        label: "Upload",
        description:
          "Upload or attach files. Images stay with this chat; supported documents can also be indexed for workspace knowledge.",
        workspaceLabel: "Upload document",
        workspaceDescription:
          "Upload documents into this workspace so Athena can organize and retrieve them later.",
      },
      quizMode: {
        label: "Test",
        description:
          "Enable test mode for the next message. Athena will prepare quiz-style questions from your prompt.",
        activeDescription:
          "Test mode is active. Your next message will generate quiz-style questions.",
      },
      fileAccess: {
        label: "File access mode",
        globalDefault: "Global default",
        modes: {
          sandbox: {
            label: "Sandbox mode",
            description:
              "Only allows access to files inside the project workspace.",
          },
          authorized: {
            label: "Authorized mode",
            description:
              "Allows access to approved local folders such as Desktop, Documents, and Downloads.",
          },
          open: {
            label: "Full open mode",
            description:
              "Allows broad local file and terminal access after approval. Use with care.",
          },
        },
        openConfirm: {
          title: "Enable full open file access?",
          description:
            "Full open mode grants broader local file access and may allow shell commands after approval.",
          confirm: "Continue",
        },
      },
    },
    text_size: "Change text size.",
    microphone: "Speak your prompt.",
    send: "Send prompt message to workspace",
    tts_speak_message: "TTS Speak message",
    copy: "Copy",
    regenerate: "Regenerate",
    regenerate_response: "Regenerate response",
    good_response: "Good response",
    more_actions: "More actions",
    metrics_visibility: {
      hover_only: "Click to show model info only when hovering",
      always_show: "Click to always show model info",
    },
    sources: "Sources",
    source_count_one: "{{count}} reference",
    source_count_other: "{{count}} references",
    document: "Document",
    similarity_match: "match",
    fork: "Fork",
    delete: "Delete",
    cancel: "Cancel",
    submit: "Submit",
    edit_prompt: "Edit prompt",
    edit_response: "Edit response",
    edit_info_user:
      '"Submit" regenerates the AI response. "Save" updates your message only.',
    edit_info_assistant:
      "Your changes will be saved directly to this response.",
    see_less: "See Less",
    see_more: "See More",
    preset_reset_description: "Clear your chat history and begin a new chat",
    preset_exit_description: "Halt the current agent session",
    add_new_preset: " Add New Preset",
    add_new: "Add new",
    edit: "Edit",
    publish: "Publish",
    stop_generating: "Stop generating response",
    command: "Command",
    your_command: "your-command",
    placeholder_prompt:
      "This is the content that will be injected in front of your prompt.",
    description: "Description",
    placeholder_description: "Responds with a poem about LLMs.",
    save: "Save",
    small: "Small",
    normal: "Normal",
    large: "Large",
    custom: "Custom",
    custom_text_size: "Custom text size",
    tools: "Tools",
    text_size_label: "Text Size",
    select_model: "Select Model",
    slash_commands: "Slash Commands",
    agent_skills: "Agent Skills",
    manage_agent_skills: "Manage Agent Skills",
    app_integrations: "App Integrations",
    custom_skills: "Custom Skills",
    agent_flows: "Agent Flows",
    sub_skills: "Sub-skills",
    no_tools_found: "No matching tools found",
    loading_mcp_servers: "Loading MCP servers...",
    start_agent_session: "Start Agent Session",
    agent_skills_disabled_in_session:
      "Can't modify skills during an active agent session. Use /exit to end the session first.",
    use_agent_session_to_use_tools:
      "You can use tools in chat by starting an agent session with '@agent' at the beginning of your prompt.",
    workspace_llm_manager: {
      search: "Search",
      loading_workspace_settings: "Loading workspace settings...",
      available_models: "Available Models for {{provider}}",
      available_models_description: "Select a model to use for this workspace.",
      save: "Use this model",
      saving: "Setting model as workspace default...",
      missing_credentials: "This provider is missing credentials!",
      missing_credentials_description: "Set up now",
    },
    toolTimeline: {
      agentThinking: "Agent is thinking...",
      agentComplete: "Agent has finished thinking",
      showThoughtChain: "Show thought chain",
      hideThoughtChain: "Hide thought chain",
      toolFallback: "tool",
      toolFamilyLabel: "{{family}} ({{toolName}})",
      actionPrefix: "Action: {{action}} · ",
      status: {
        calling: "Calling",
        returned: "Returned",
        errored: "Errored",
        working: "Working...",
        finished: "Finished.",
      },
      templates: {
        assemblingToolCall: "Assembling tool call: {{tool}} {{args}}",
        parsedToolCall: "Parsed tool call: {{tool}} {{args}}",
        toolCall: "Tool call: {{tool}} {{args}}",
        executingTool: "@agent is executing {{tool}} tool {{args}}",
        contextFound:
          "@agent found {{count}} additional context item(s) to help answer this question.",
        toolReturned: "{{tool}} returned a result.",
        callingTool: "Calling {{tool}}...",
      },
      tools: {
        "rag-memory": "RAG memory",
        "document-ingest-agent": "Document ingest agent",
        "document-summarizer": "Document summarizer",
        "web-browsing": "Web browsing",
        "web-scraping": "Web scraping",
        "chat-history": "Chat history",
        "file-history": "File history",
        "shell-agent": "Shell agent",
        "create-chart": "Chart creator",
        "sql-agent": "SQL agent",
      },
      toolFamilies: {
        filesystem: "Filesystem tool",
        create: "File creation tool",
        gmail: "Gmail tool",
        outlook: "Outlook tool",
        gcal: "Google Calendar tool",
        sql: "SQL tool",
      },
      actions: {
        search: "search",
        store: "store",
        read: "read",
        write: "write",
        create: "create",
        update: "update",
        delete: "delete",
        list: "list",
        get: "get",
        send: "send",
        reply: "reply",
        move: "move",
        mark: "mark",
        query: "query",
      },
    },
    agent_invocation: {
      model_wants_to_call: "Model wants to call",
      approve: "Approve",
      reject: "Reject",
      always_allow: "Always allow {{skillName}}",
      tool_call_was_approved: "Tool call was approved",
      tool_call_was_rejected: "Tool call was rejected",
    },
  },
  profile_settings: {
    edit_account: "Edit Account",
    profile_picture: "Profile Picture",
    remove_profile_picture: "Remove Profile Picture",
    username: "Username",
    new_password: "New Password",
    password_description: "Password must be at least 8 characters long",
    cancel: "Cancel",
    update_account: "Update Account",
    theme: "Theme Preference",
    language: "Preferred language",
    failed_upload: "Failed to upload profile picture: {{error}}",
    upload_success: "Profile picture uploaded.",
    failed_remove: "Failed to remove profile picture: {{error}}",
    profile_updated: "Profile updated.",
    failed_update_user: "Failed to update user: {{error}}",
    account: "Account",
    support: "Support",
    signout: "Sign out",
  },
  "keyboard-shortcuts": {
    title: "Keyboard Shortcuts",
    shortcuts: {
      settings: "Open Settings",
      workspaceSettings: "Open Current Workspace Settings",
      home: "Go to Home",
      workspaces: "Manage Workspaces",
      apiKeys: "API Keys Settings",
      llmPreferences: "LLM Preferences",
      chatSettings: "Chat Settings",
      help: "Show keyboard shortcuts help",
      showLLMSelector: "Show workspace LLM Selector",
    },
  },
  community_hub: {
    publish: {
      system_prompt: {
        success_title: "Success!",
        success_description:
          "Your System Prompt has been published to the Community Hub!",
        success_thank_you: "Thank you for sharing to the Community!",
        view_on_hub: "View on Community Hub",
        modal_title: "Publish System Prompt",
        name_label: "Name",
        name_description: "This is the display name of your system prompt.",
        name_placeholder: "My System Prompt",
        description_label: "Description",
        description_description:
          "This is the description of your system prompt. Use this to describe the purpose of your system prompt.",
        tags_label: "Tags",
        tags_description:
          "Tags are used to label your system prompt for easier searching. You can add multiple tags. Max 5 tags. Max 20 characters per tag.",
        tags_placeholder: "Type and press Enter to add tags",
        visibility_label: "Visibility",
        public_description: "Public system prompts are visible to everyone.",
        private_description: "Private system prompts are only visible to you.",
        publish_button: "Publish to Community Hub",
        submitting: "Publishing...",
        prompt_label: "Prompt",
        prompt_description:
          "This is the actual system prompt that will be used to guide the LLM.",
        prompt_placeholder: "Enter your system prompt here...",
      },
      agent_flow: {
        success_title: "Success!",
        success_description:
          "Your Agent Flow has been published to the Community Hub!",
        success_thank_you: "Thank you for sharing to the Community!",
        view_on_hub: "View on Community Hub",
        modal_title: "Publish Agent Flow",
        name_label: "Name",
        name_description: "This is the display name of your agent flow.",
        name_placeholder: "My Agent Flow",
        description_label: "Description",
        description_description:
          "This is the description of your agent flow. Use this to describe the purpose of your agent flow.",
        tags_label: "Tags",
        tags_description:
          "Tags are used to label your agent flow for easier searching. You can add multiple tags. Max 5 tags. Max 20 characters per tag.",
        tags_placeholder: "Type and press Enter to add tags",
        visibility_label: "Visibility",
        submitting: "Publishing...",
        submit: "Publish to Community Hub",
        privacy_note:
          "Agent flows are always uploaded as private to protect any sensitive data. You can change the visibility in the Community Hub after publishing. Please verify your flow does not contain any sensitive or private information before publishing.",
      },
      slash_command: {
        success_title: "Success!",
        success_description:
          "Your Slash Command has been published to the Community Hub!",
        success_thank_you: "Thank you for sharing to the Community!",
        view_on_hub: "View on Community Hub",
        modal_title: "Publish Slash Command",
        name_label: "Name",
        name_description: "This is the display name of your slash command.",
        name_placeholder: "My Slash Command",
        description_label: "Description",
        description_description:
          "This is the description of your slash command. Use this to describe the purpose of your slash command.",
        tags_label: "Tags",
        tags_description:
          "Tags are used to label your slash command for easier searching. You can add multiple tags. Max 5 tags. Max 20 characters per tag.",
        tags_placeholder: "Type and press Enter to add tags",
        visibility_label: "Visibility",
        public_description: "Public slash commands are visible to everyone.",
        private_description: "Private slash commands are only visible to you.",
        publish_button: "Publish to Community Hub",
        submitting: "Publishing...",
        prompt_label: "Prompt",
        prompt_description:
          "This is the prompt that will be used when the slash command is triggered.",
        prompt_placeholder: "Enter your prompt here...",
      },
      generic: {
        unauthenticated: {
          title: "Authentication Required",
          description:
            "You need to authenticate with the Athena Community Hub before publishing items.",
          button: "Connect to Community Hub",
        },
      },
    },
  },
  scheduledJobs: {
    title: "Scheduled Jobs",
    enableNotifications: "Enable browser notifications for job results",
    description:
      "Create recurring AI tasks that run on a schedule. Each job runs a prompt with optional tools and saves the result for review.",
    newJob: "New Job",
    loading: "Loading...",
    emptyTitle: "No Scheduled Jobs yet",
    emptySubtitle: "Create one to get started.",
    table: {
      name: "Name",
      schedule: "Schedule",
      status: "Status",
      lastRun: "Last Run",
      nextRun: "Next Run",
      actions: "Actions",
    },
    confirmDelete: "Are you sure you want to delete this scheduled job?",
    status: {
      completed: "Completed",
      failed: "Failed",
      timed_out: "Timed out",
      running: "Running",
      queued: "Queued",
    },
    toast: {
      deleted: "Job deleted",
      triggered: "Job triggered successfully",
      triggerFailed: "Failed to trigger job",
      triggerSkipped: "A run is already in progress for this job",
      killed: "Job stopped successfully",
      killFailed: "Failed to stop job",
    },
    row: {
      neverRun: "Never run",
      viewRuns: "View runs",
      runNow: "Run now",
      enable: "Enable",
      disable: "Disable",
      edit: "Edit",
      delete: "Delete",
    },
    modal: {
      titleEdit: "Edit Scheduled Job",
      titleNew: "New Scheduled Job",
      nameLabel: "Name",
      namePlaceholder: "e.g. Daily News Digest",
      promptLabel: "Prompt",
      promptPlaceholder: "The instruction to run on each execution...",
      scheduleLabel: "Schedule",
      modeBuilder: "Builder",
      modeCustom: "Custom",
      cronPlaceholder: "Cron expression (e.g. 0 9 * * *)",
      currentSchedule: "Current schedule:",
      toolsLabel: "Tools (Optional)",
      toolsDescription:
        "Select which agent tools this job can use. If none are selected, the job runs without any tools.",
      toolsSearch: "Search",
      toolsNoResults: "No tools match",
      required: "Required",
      requiredFieldsBanner:
        "Please fill out all required fields in order to create job.",
      cancel: "Cancel",
      saving: "Saving...",
      updateJob: "Update Job",
      createJob: "Create Job",
      jobUpdated: "Job updated",
      jobCreated: "Job created",
    },
    builder: {
      fallbackWarning:
        "This expression can't be edited visually. Switch to Custom to keep it, or change anything below to overwrite it.",
      run: "Run",
      frequency: {
        minute: "every minute",
        hour: "hourly",
        day: "daily",
        week: "weekly",
        month: "monthly",
      },
      every: "Every",
      minuteOne: "1 minute",
      minuteOther: "{{count}} minutes",
      atMinute: "At minute",
      pastEveryHour: "past every hour",
      at: "At",
      on: "On",
      onDay: "On day",
      ofEveryMonth: "of every month",
      weekdays: {
        sun: "Sun",
        mon: "Mon",
        tue: "Tue",
        wed: "Wed",
        thu: "Thu",
        fri: "Fri",
        sat: "Sat",
      },
    },
    runHistory: {
      back: "Back to jobs",
      title: "Run History: {{name}}",
      schedule: "Schedule:",
      emptyTitle: "No runs yet for this job",
      emptySubtitle: "Run the job now and view its results.",
      runNow: "Run Now",
      stopJob: "Stop job",
      table: {
        status: "Status",
        started: "Started",
        duration: "Duration",
        error: "Error",
      },
    },
    runDetail: {
      loading: "Loading run details...",
      notFound: "Run not found.",
      back: "Back",
      unknownJob: "Unknown Job",
      runHeading: "{{name}} — Run #{{id}}",
      duration: "Duration: {{value}}",
      continueInThread: "Continue in Chat",
      creating: "Creating...",
      threadFailed: "Failed to create thread",
      stopJob: "Stop Job",
      killing: "Stopping...",
      sections: {
        prompt: "Prompt",
        error: "Error",
        thinking: "Thoughts ({{count}})",
        toolCalls: "Tool Calls ({{count}})",
        files: "Files ({{count}})",
        response: "Response",
        metrics: "Metrics",
      },
      metrics: {
        promptTokens: "Prompt tokens:",
        completionTokens: "Completion tokens:",
      },
    },
    toolCall: {
      arguments: "Arguments:",
      showResult: "Show result",
      hideResult: "Hide result",
    },
    file: {
      unknown: "Unknown file",
      download: "Download",
      downloadFailed: "Failed to download file",
      types: {
        powerpoint: "PowerPoint",
        pdf: "PDF Document",
        word: "Word Document",
        spreadsheet: "Spreadsheet",
        generic: "File",
      },
    },
  },
};

export default TRANSLATIONS;
