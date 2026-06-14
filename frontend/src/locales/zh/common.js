// Anything with "null" requires a translation. Contribute to translation via a PR!
const TRANSLATIONS = {
  onboarding: {
    home: {
      getStarted: "开始",
      welcome: "欢迎",
    },
    llm: {
      title: "LLM 偏好",
      description:
        "Athena可以与多家 LLM 提供商配合使用。这将是处理聊天的服务。",
    },
    userSetup: {
      title: "用户设置",
      description: "配置你的用户设置。",
      howManyUsers: "将有多少用户使用此实例？",
      justMe: "只有我",
      myTeam: "我的团队",
      instancePassword: "实例密码",
      setPassword: "你想要设置密码吗？",
      passwordReq: "密码必须至少包含 8 个字符。",
      passwordWarn: "保存此密码很重要，因为没有恢复方法。",
      adminUsername: "管理员账户用户名",
      adminPassword: "管理员账户密码",
      adminPasswordReq: "密码必须至少包含 8 个字符。",
      teamHint:
        "默认情况下，你将是唯一的管理员。完成初始设置后，你可以创建和邀请其他人成为用户或管理员。不要丢失你的密码，因为只有管理员可以重置密码。",
    },
    data: {
      title: "数据处理与隐私",
      description: "我们致力于在涉及你的个人数据时提供透明度和控制权。",
      settingsHint: "这些设置可以随时在设置中重新配置。",
    },
    survey: {
      title: "欢迎使用Athena",
      description: "帮助我们根据你的需求打造Athena。可选。",
      email: "你的电子邮件是什么？",
      useCase: "你将如何使用Athena？",
      useCaseWork: "用于工作",
      useCasePersonal: "用于个人使用",
      useCaseOther: "其他",
      comment: "你是如何听说Athena的？",
      commentPlaceholder:
        "Reddit，Twitter，GitHub，YouTube 等 - 让我们知道你是如何找到我们的！",
      skip: "跳过调查",
      thankYou: "感谢你的反馈！",
    },
  },
  common: {
    productName: "Athena",
    defaultSiteTitle: "Athena | 知识操作系统",
    controls: {
      settings: "设置",
      settingsDescription:
        "打开系统设置，调整界面、模型提供商、安全和工作区管理等配置。",
      workspaceSettings: "工作区设置",
      workspaceSettingsDescription:
        "打开此工作区设置，调整外观、文档、成员和行为配置。",
      backToWorkspace: "返回工作区",
      showSidebar: "展开侧边栏（{{shortcut}}）",
      hideSidebar: "关闭侧边栏（{{shortcut}}）",
    },
    clear: "清除",
    thread: "线程",
    default: "默认",
    overviewPage: "总览页",
    newThread: "新线程",
    startingThread: "正在创建线程...",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    "return-running-thread": "返回正在运行的线程",
    "workspaces-name": "工作区名称",
    selection: "模型选择",
    save: "保存更改",
    saving: "保存中...",
    previous: "上一页",
    next: "下一页",
    optional: "可选",
    yes: "是",
    no: "否",
    search: "搜索",
    developmentMode: "开发模式",
    username_requirements:
      "用户名必须为 2-32 个字符，以小写字母开头，只能包含小写字母、数字、下划线、连字符和句点。",
    on: "关于",
    none: "没有",
    stopped: "停止",
    loading: "正在加载…",
    refresh: "重新开始；更新",
  },
  settings: {
    title: "设置",
    invites: "邀请",
    users: "用户",
    workspaces: "工作区",
    "workspace-chats": "对话历史记录",
    customization: "外观",
    interface: "界面偏好",
    branding: "品牌与白标签化",
    chat: "聊天",
    "api-keys": "开发者API",
    llm: "大语言模型（LLM）",
    transcription: "转录模型",
    embedder: "嵌入器（Embedder）",
    reranker: "重排模型（Rerank）",
    ocr: "OCR 模型",
    vision: "视觉模型",
    "text-splitting": "文本分割",
    "batch-jobs": "批处理任务",
    "voice-speech": "语音和讲话",
    "vector-database": "向量数据库",
    embeds: "嵌入式对话",
    security: "用户与安全",
    "button-lab": "按钮实验",
    "crypto-component-experiment": "加密组件实验",
    "crypto-center": "Crypto Center",
    "event-logs": "事件日志",
    privacy: "隐私与数据",
    "ai-providers": "人工智能提供商",
    "agent-skills": "代理技能",
    admin: "管理员",
    tools: "工具",
    "experimental-features": "实验功能",
    contact: "联系支持",
    "browser-extension": "浏览器扩展",
    "system-prompt-variables": "系统提示变量",
    "default-system-prompt": "默认系统提示词",
    "mobile-app": "Athena 移动版",
    "community-hub": {
      title: "社区中心",
      trending: "探索热门",
      "your-account": "您的账户",
      "import-item": "进口商品",
    },
    channels: "频道",
    "available-channels": {
      telegram: "电报连接器",
      wechat: "微信连接器",
      "advanced-gateway": "高级连接器",
    },
    "scheduled-jobs": "计划好的任务",
  },
  login: {
    "multi-user": {
      welcome: "欢迎！",
      "placeholder-username": "请输入用户名",
      "placeholder-password": "请输入密码",
      login: "登录",
      validating: "正在验证...",
      "forgot-pass": "忘记密码",
      reset: "重置",
    },
    "sign-in": "登录你的 {{appName}} 账户",
    "password-reset": {
      title: "重置密码",
      description: "请提供以下必要信息以重置你的密码。",
      "recovery-codes": "恢复代码",
      "back-to-login": "返回登录",
      "email-title": "邮箱验证码重置密码",
      "email-description": "使用已验证的账号邮箱接收 6 位验证码。",
      "verified-email": "已验证邮箱",
      "verification-code": "验证码",
      "send-code": "发送验证码",
      "resend-code-in": "{{seconds}} 秒后可重发",
      sending: "发送中...",
      "use-email": "改用邮箱验证码",
      "use-recovery-codes": "改用恢复代码",
      "generic-email-sent": "如果账号和已验证邮箱存在，验证码将发送到该邮箱。",
    },
  },
  "main-page": {
    quickActions: {
      createAgent: "创建代理",
      editWorkspace: "编辑工作区",
      uploadDocument: "上传文件",
    },
    greeting: "今天我能帮您什么？",
  },
  "new-workspace": {
    title: "新工作区",
    placeholder: "我的工作区",
  },
  "workspaces—settings": {
    general: "通用设置",
    chat: "聊天设置",
    vector: "向量数据库",
    health: "健康中心",
    reading: "阅读工具",
    members: "成员",
    agent: "代理配置",
  },
  "reading-tools": {
    eyebrow: "阅读工具",
    title: "字体大小与阅读预览",
    description:
      "字体大小是本地浏览器阅读偏好，只影响当前设备上的聊天阅读体验，不会写入工作区设置。",
    sizeTitle: "字号选择",
    previewTitle: "实时预览",
    currentSelection: "当前选择：{{label}}",
    customSliderLabel: "自定义字号",
    customRange: "{{min}}px 到 {{max}}px",
    userPreview: "用户消息预览：请帮我把这份资料整理成清晰的知识结构。",
    options: {
      small: {
        label: "小号",
        description: "更紧凑，适合长对话快速浏览。",
      },
      normal: {
        label: "标准",
        description: "Athena 默认阅读大小。",
      },
      large: {
        label: "大号",
        description: "更舒服，适合长时间阅读和演示。",
      },
      custom: {
        label: "自定义",
        labelWithSize: "自定义 {{size}}px",
        description: "拖动滑杆，以 1px 为颗粒度调整。",
      },
    },
    previewMarkdown: `### 助手回答预览

这是一段 **Markdown 加粗文本**，用于确认阅读字号、行距和强调样式是否舒适。

- 列表项目会保持清晰间距
- 中文和 English text 会一起展示

> 引用块用于展示来源摘录或推理说明。

\`\`\`js
const readable = true;
\`\`\`
`,
  },
  "workspace-health": {
    unavailable: "暂无",
    unknown: "未知",
    unknownEyebrow: "状态暂不可用",
    processing: "处理中",
    processingEyebrow: "后台任务运行中",
    healthy: "健康",
    healthyEyebrow: "运行状态良好",
    attention: "需关注",
    attentionEyebrow: "存在轻微风险",
    degraded: "降级",
    degradedEyebrow: "需要排查",
    critical: "严重",
    criticalEyebrow: "需要立即处理",
    warning: "警告",
    info: "信息",
    scoreUnit: "分",
    ariaOpen: "工作区健康状态：{{score}}，{{status}}，按 Enter 打开健康中心",
    title: "工作区健康中心",
    eyebrow: "工作区可观察性",
    description:
      "这里展示知识图谱、修复任务、节点指标、后台 Worker、队列、模型服务与缓存的轻量可观察状态。刷新只更新健康聚合缓存，不会触发嵌入、向量重建、知识图谱提取或修复任务。",
    refresh: "刷新健康状态",
    refreshAfter: "{{seconds}}s 后可刷新",
    healthScore: "工作区健康分数",
    lastUpdated: "最后更新时间：{{time}}",
    summaryCache: "摘要缓存：{{time}}",
    latestActivity: "最新活动：{{time}}",
    workerHeartbeat: "Worker 心跳：{{time}}",
    summaryFallback: "健康状态暂时不可用",
    currentIssues: "当前问题",
    scoreSources: "具体扣分来源",
    noScoreSources: "当前没有实际扣分项。该问题可能已在最新健康聚合中恢复。",
    pointsLost: "-{{points}} 分",
    severity: "严重程度：{{severity}}",
    cacheNote:
      "缓存说明：当前有 {{count}} 条过期 traversal 缓存。缓存会按需重建，不影响健康分数。",
    noIssues: "暂无需要立即处理的问题。",
    processingTitle: "正在处理",
    noProcessing: "当前没有正在处理的健康任务。",
    timeline: "最近活动时间线",
    recentActivity: "最近活动",
    abnormalEvents: "异常事件",
    noRecentActivity: "暂无最近活动。",
    advancedInfo: "高级信息",
    advancedDiagnostics: "高级诊断数据",
    dataSourceTimes: "数据来源时间",
    adjustReadingTools: "调整阅读工具与字体大小",
    fullDiagnostics: "查看完整诊断",
    activityTitles: {
      nodeMetrics: "节点指标",
      kgExtraction: "知识图谱提取",
      graphRepair: "图谱修复",
      recomputeNodeMetrics: "重新计算节点指标",
    },
    activityDetails: {
      processed: "处理",
      succeeded: "成功",
      failed: "失败",
      skipped: "跳过",
    },
  },
  "workspace-overview": {
    workspaceOverview: "工作区总览",
    overviewGenerating: "总览生成中",
    workspaceHealth: "工作区健康",
    unknown: "未知",
    healthUnavailable: "健康状态暂不可用",
    healthNote: "推荐、证据、关系与处理状态的综合读数",
    continueLast: "继续上次研究",
    noContinue: "暂无可恢复的研究路径。",
    recommended: "为你推荐",
    noRecommendations: "暂无推荐。继续查看概念或证据后，这里会变得更聪明。",
    knowledgeGaps: "知识缺口",
  },
  workspaceSupplement: {
    tool: {
      title: "工具预览",
      description: "这些补充会作为按需工具暴露给模型，不会一次性塞入上下文。",
      availableKinds: "可用补充类型",
      customDocuments: "自定义补充文档",
      noAvailableSupplements: "暂无可用补充",
    },
    kinds: {
      structure_json: "结构说明",
      reading_guide: "阅读导引",
      chapter_overview: "章节总览",
      timeline: "时间线",
      person_map: "人物关系",
      concept_index: "概念索引",
      summary_standard: "总结标准",
    },
    kindDescriptions: {
      structure_json: "用于结构、主轴、次轴和节点解析标准。",
      reading_guide: "用于阅读顺序、主题边界和学习方式。",
      chapter_overview: "用于章节作用、章节关系和学习重点。",
      timeline: "用于时间顺序、事件发展和因果关系。",
      person_map: "用于人物观点、影响链和对比关系。",
      concept_index: "用于概念定义、关联概念和易错点。",
      summary_standard: "用于总结结构、覆盖维度和禁止误判项。",
    },
    customDocumentDescription: "按具体标题暴露的自定义补充文档。",
    structureJsonValid: "结构有效",
    structureJsonInvalid: "结构待确认",
    usagePreview: "预览",
  },
  "system-prompt-variables": {
    title: "系统提示变量",
    description:
      "系统提示变量用于保存配置值，可在系统提示词中引用，以便在提示词中启用动态内容。",
    addVariable: "添加变量",
    noVariables: "未找到变量",
    edit: "编辑",
    columns: {
      key: "键",
      value: "值",
      description: "描述",
      type: "类型",
    },
    types: {
      system: "系统",
      user: "用户",
      workspace: "工作区",
      static: "静态",
    },
    variableDescriptions: {
      time: "当前时间",
      date: "当前日期",
      datetime: "当前日期和时间",
      "user.id": "当前用户的 ID",
      "user.name": "当前用户的用户名",
      "user.bio": "当前用户个人资料中的简介字段",
      "workspace.id": "当前工作区的 ID",
      "workspace.name": "当前工作区的名称",
    },
    form: {
      addTitle: "添加新变量",
      editTitle: "编辑 {{key}}",
      keyPlaceholder: "例如：company_name",
      valuePlaceholder: "例如：Acme Corp",
      descriptionPlaceholder: "可选描述",
      keyHint:
        "键必须唯一，并会以 {key} 的形式在提示词中使用。只允许使用字母、数字和下划线。",
      cancel: "取消",
      create: "创建变量",
      update: "更新变量",
    },
    deleteConfirm: {
      title: "删除变量？",
      description: "将删除变量“{{key}}”，此操作无法撤销。",
      confirm: "删除",
    },
    toasts: {
      created: "变量创建成功",
      updated: "变量更新成功",
      deleted: "变量删除成功",
    },
    errors: {
      prefix: "错误",
      required: "键和值为必填项",
      create: "创建变量失败",
      update: "更新变量失败",
      delete: "删除变量失败",
    },
  },
  "experimental-features": {
    title: "实验功能",
    selectFeature: "选择一个实验功能",
    status: {
      on: "开启",
      off: "关闭",
    },
    toasts: {
      enabledSet: "实验功能集已启用。正在重新加载页面。",
    },
    tos: {
      title: "实验功能使用条款",
      introStart: "Athena 的实验功能是我们正在试运行的功能，并且需要",
      introSeparator: "",
      optIn: "主动选择启用",
      optInSuffix: "。",
      introEnd:
        "在批准任何功能之前，如存在潜在问题，我们会主动给出条件说明或警告。",
      risksIntro: "使用本页任何功能可能导致但不限于以下情况。",
      risks: {
        dataLoss: "数据丢失。",
        qualityChange: "结果质量发生变化。",
        storageIncrease: "存储占用增加。",
        resourceIncrease: "资源消耗增加。",
        cost: "任何已连接的 LLM 或嵌入模型提供商的费用或使用量增加。",
        bugs: "使用 Athena 时可能出现错误或问题。",
      },
      conditionsIntro: "使用实验功能还附带以下非穷尽条件。",
      conditions: {
        futureRemoval: "该功能未来更新中可能不再存在。",
        unstable: "正在使用的功能目前并不稳定。",
        availability:
          "该功能未来可能无法在某些版本、配置或 Athena 订阅中使用。",
        privacyStart: "使用任何测试功能时，你的隐私设置",
        privacySeparator: "",
        privacyBold: "都会得到遵守",
        privacyEnd: "。",
        mayChange: "这些条件未来更新中可能会变化。",
      },
      moreInfoPrefix:
        "访问任何功能都需要先同意此弹窗。如果想了解更多信息，可以查看",
      moreInfoOrEmail: "或发送邮件至",
      reject: "拒绝并关闭",
      accept: "我已理解",
    },
    liveSync: {
      navTitle: "实时文档同步",
      title: "自动文档内容同步",
      description:
        "启用后可以指定要“监视”的文档。被监视文档的内容会定期获取并更新到 Athena。",
      workspaceUpdate: "被监视的文档会在更新时同步更新到所有引用它们的工作区。",
      webOnly:
        "此功能仅适用于基于 Web 的内容，例如网站、Confluence、YouTube 和 GitHub 文件。",
      docsLink: "功能文档和警告",
      manageLink: "管理被监视的文档",
      toasts: {
        enabled: "实时文档内容同步已启用。",
        disabled: "实时文档内容同步已禁用。",
      },
      errors: {
        update: "更新功能状态失败。",
      },
      manage: {
        title: "被监视的文档",
        description:
          "这里列出当前实例中所有正在被监视的文档。这些文档的内容会定期同步。",
        columns: {
          documentName: "文档名称",
          lastSynced: "上次同步",
          nextRefresh: "距离下次刷新",
          createdOn: "创建时间",
        },
      },
    },
  },
  "audio-preference": {
    stt: {
      title: "语音转文本偏好",
      description:
        "在这里可以指定你希望在 Athena 体验中使用哪种文本转语音和语音转文本提供商。默认情况下，我们使用浏览器内置的这些服务支持，但你也可以使用其他提供商。",
      searchPlaceholder: "搜索语音转文本提供商",
    },
    tts: {
      title: "文本转语音偏好",
      description:
        "在这里可以指定你希望在 Athena 体验中使用哪种文本转语音提供商。默认情况下，我们使用浏览器内置的这些服务支持，但你也可以使用其他提供商。",
      searchPlaceholder: "搜索文本转语音提供商",
    },
    provider: "提供商",
    noConfiguration: "此提供商无需配置。",
    loadingModels: "-- 正在加载可用模型 --",
    providers: {
      native: {
        name: "系统原生",
        sttDescription: "如果支持，将使用浏览器内置的 STT 服务。",
        ttsDescription: "如果支持，将使用浏览器内置的 TTS 服务。",
      },
      openai: {
        description: "使用 OpenAI 的文本转语音声音。",
      },
      elevenlabs: {
        description: "使用 ElevenLabs 的文本转语音声音和技术。",
      },
      piper: {
        description: "在浏览器中本地私密运行 TTS 模型。",
      },
      openaiCompatible: {
        name: "OpenAI 兼容",
        description: "连接到本地或远程运行的 OpenAI 兼容 TTS 服务。",
      },
    },
    fields: {
      apiKey: "API 密钥",
      baseUrl: "基础 URL",
      ttsModel: "TTS 模型",
      voiceModel: "声音模型",
      voiceModelSelection: "声音模型选择",
    },
    toasts: {
      sttSaved: "语音转文本偏好已成功保存。",
      sttSaveFailed: "保存偏好失败：{{error}}",
      ttsSaved: "文本转语音偏好已成功保存。",
      ttsSaveFailed: "保存偏好失败：{{error}}",
    },
    piper: {
      description:
        "所有 PiperTTS 模型都会在你的浏览器中本地运行。低端设备上可能会消耗较多资源。",
      storedModelHint: "“✔”表示该模型已存储在本地，运行时无需再次下载。",
      flushCache: "清空声音缓存",
      stopDemo: "停止演示",
      loadingVoice: "正在加载声音",
      playSample: "播放示例",
      toasts: {
        flushed: "已从浏览器存储中清空所有声音",
      },
    },
    openaiCompatible: {
      baseUrlHint:
        "这里应填写 OpenAI 兼容 TTS 服务的基础 URL，用于生成 TTS 响应。",
      apiKeyHint:
        "某些 TTS 服务需要 API 密钥才能生成 TTS 响应。如果你的服务不需要密钥，则此项可选。",
      ttsPlaceholder: "你的 TTS 模型标识符",
      voicePlaceholder: "你的声音模型标识符",
      ttsModelHintStart: "大多数 TTS 服务会提供多个模型。这是你用于选择模型的",
      ttsModelHintEnd: "参数。注意：这不同于声音模型。",
      voiceModelHint:
        "大多数 TTS 服务会提供多个声音模型，这里填写你想使用的声音模型标识符。",
    },
  },
  "default-system-prompt": {
    title: "默认系统提示词",
    description: "这是新工作区将使用的默认系统提示词。",
    form: {
      label: "系统提示词",
      helpStart:
        "系统提示词提供用于塑造 AI 回复和行为的指令。此提示词会自动应用到所有新创建的工作区。若要更改",
      helpStartSeparator: "",
      specificWorkspace: "特定工作区",
      helpMiddle: "的系统提示词，请在",
      helpMiddleSeparator: "",
      workspaceSettings: "工作区设置",
      helpEnd:
        "中编辑提示词。若要将系统提示词恢复为我们的合理默认值，请留空此字段并保存更改。",
      variablesPrefix: "你可以插入",
      variablesLink: "系统提示变量",
      variablesLike: "例如：",
      moreVariables: "+{{count}} 个更多...",
      placeholder: "你是一个可以回答问题并协助完成任务的 AI 助手。",
      syncExisting: "同步到已有默认工作区",
      syncExistingHint:
        "仅更新仍使用旧默认提示词的工作区，不覆盖单独自定义过的系统提示词。",
    },
    toasts: {
      updated: "默认系统提示词已成功更新。",
      updatedWithSync:
        "默认系统提示词已成功更新。已同步 {{synced}} 个工作区，跳过 {{skipped}} 个自定义工作区，失败 {{failed}} 个。",
      updateFailed: "更新默认系统提示词失败：{{error}}",
    },
  },
  general: {
    vector: {
      title: "向量数量",
      description: "向量数据库中的总向量数。",
    },
    names: {
      description: "这只会更改工作区的显示名称。",
    },
    message: {
      title: "建议的聊天消息",
      description: "自定义将向你的工作区用户建议的消息。",
      add: "添加新消息",
      save: "保存消息",
      heading: "向我解释",
      body: "Athena的好处",
    },
    delete: {
      title: "删除工作区",
      description: "删除此工作区及其所有数据。这将删除所有用户的工作区。",
      delete: "删除工作区",
      deleting: "正在删除工作区...",
      "confirm-start": "你即将删除整个",
      "confirm-end":
        "工作区。这将删除矢量数据库中的所有矢量嵌入。\n\n原始源文件将保持不变。此操作是不可逆转的。",
    },
  },
  chat: {
    llm: {
      title: "工作区 LLM 提供者",
      description:
        "将用于此工作区的特定 LLM 提供商和模型。默认情况下，它使用系统 LLM 提供程序和设置。",
      search: "搜索所有 LLM 提供商",
    },
    model: {
      title: "工作区聊天模型",
      description:
        "将用于此工作区的特定聊天模型。如果为空，将使用系统 LLM 首选项。",
    },
    mode: {
      title: "聊天模式",
      chat: {
        title: "聊天",
        description:
          "将提供答案，利用LLM的通用知识和提供的文档内容<b>和</b>。您需要使用@agent命令来使用工具。",
      },
      query: {
        title: "查询",
        description:
          "将在找到文档上下文时，仅提供答案 <b>。您需要使用 @agent 命令来使用工具。",
      },
      automatic: {
        description:
          "如果模型和提供者都支持原生工具调用，则会自动使用这些工具。<br />如果不支持原生工具调用，您需要使用 `@agent` 命令来使用工具。",
        title: "代理",
      },
    },
    history: {
      title: "聊天历史记录",
      "desc-start": "将包含在响应的短期记忆中的先前聊天的数量。",
      recommend: "推荐 20。",
      "desc-end":
        "任何超过 45 的值都可能导致连续聊天失败，具体取决于消息大小。",
    },
    prompt: {
      title: "系统提示词",
      description:
        "将在此工作区上使用的提示词。定义 AI 生成响应的上下文和指令。你应该提供精心设计的提示，以便人工智能可以生成相关且准确的响应。",
      history: {
        title: "系统提示词历史",
        clearAll: "全部清除",
        noHistory: "没有可用的系统提示词历史记录",
        restore: "恢复",
        delete: "删除",
        deleteConfirm: "您确定要删除此历史记录吗？",
        clearAllConfirm: "您确定要清除所有历史记录吗？此操作无法撤消。",
        expand: "展开",
        publish: "发布到社区中心",
      },
    },
    refusal: {
      title: "查询模式拒绝响应",
      "desc-start": "当处于",
      query: "查询",
      "desc-end": "模式时，当未找到上下文时，你可能希望返回自定义拒绝响应。",
      "tooltip-title": "我为什麽会看到这个?",
      "tooltip-description":
        "您处于查询模式，此模式仅使用您文件中的信息。切换到聊天模式以进行更灵活的对话，或点击此处访问我们的文件以了解更多关于聊天模式的信息。",
    },
    temperature: {
      title: "LLM 温度",
      "desc-start": "此设置控制你的 LLM 回答的“创意”程度",
      "desc-end":
        "数字越高越有创意。对于某些模型，如果设置得太高，可能会导致响应不一致。",
      hint: "大多数 LLM 都有各种可接受的有效值范围。请咨询你的LLM提供商以获取该信息。",
    },
  },
  "vector-workspace": {
    identifier: "向量数据库标识符",
    snippets: {
      title: "最大上下文片段",
      description:
        "此设置控制每次聊天或查询将发送到 LLM 的上下文片段的最大数量。",
      recommend: "推荐: 4",
    },
    doc: {
      title: "文档相似性阈值",
      description:
        "源被视为与聊天相关所需的最低相似度分数。数字越高，来源与聊天就越相似。",
      zero: "无限制",
      low: "低（相似度分数 ≥ .25）",
      medium: "中（相似度分数 ≥ .50）",
      high: "高（相似度分数 ≥ .75）",
    },
    reset: {
      reset: "重置向量数据库",
      resetting: "清除向量...",
      confirm:
        "你将重置此工作区的矢量数据库。这将删除当前嵌入的所有矢量嵌入。\n\n原始源文件将保持不变。此操作是不可逆转的。",
      success: "向量数据库已重置。",
      error: "无法重置工作区向量数据库！",
    },
  },
  agent: {
    "performance-warning":
      "不明确支持工具调用的 LLMs 的性能高度依赖于模型的功能和准确性。有些能力可能受到限制或不起作用。",
    provider: {
      title: "工作区代理 LLM 提供商",
      description: "将用于此工作区的 @agent 代理的特定 LLM 提供商和模型。",
    },
    mode: {
      chat: {
        title: "工作区代理聊天模型",
        description: "将用于此工作区的 @agent 代理的特定聊天模型。",
      },
      title: "工作区代理模型",
      description: "将用于此工作区的 @agent 代理的特定 LLM 模型。",
      wait: "-- 等待模型 --",
    },
    skill: {
      rag: {
        title: "检索增强生成和长期记忆",
        description:
          '允许代理利用你的本地文档来回答查询，或要求代理"记住"长期记忆检索的内容片段。',
      },
      ingest: {
        title: "文档入库",
        description: "允许代理把已上传或已解析的文档加入当前工作区知识库。",
      },
      view: {
        title: "查看和总结文档",
        description: "允许代理列出和总结当前嵌入的工作区文件的内容。",
      },
      scrape: {
        title: "抓取网站",
        description: "允许代理访问和抓取网站的内容。",
      },
      generate: {
        title: "生成图表",
        description: "使默认代理能够从提供的数据或聊天中生成各种类型的图表。",
      },
      web: {
        title: "实时网络搜索和浏览",
        description:
          "通过连接到搜索引擎（SERP）提供商，让您的代理能够搜索互联网来回答您的问题。",
      },
      sql: {
        title: "SQL 连接器",
        description:
          "让您的代理能够利用 SQL 来回答您的问题，只需连接到各种 SQL 数据库提供商即可。",
      },
      default_skill:
        "默认情况下，这项技能已启用。但是，如果您不想让该技能被代理使用，您可以将其禁用。",
      filesystem: {
        title: "文件系统访问",
        description:
          "允许您的代理能够读取、写入、搜索和管理指定目录中的文件。 支持文件编辑、目录导航和内容搜索功能。",
        learnMore: "了解更多关于如何使用这项技能的信息。",
        configuration: "配置",
        readActions: "阅读操作",
        writeActions: "编写操作",
        warning:
          "访问文件系统可能存在风险，因为它可能修改或删除文件。在启用之前，请务必查阅<a>文档</a>。",
        skills: {
          "read-text-file": {
            title: "读取文件",
            description: "读取文件内容（包括文本、代码、PDF、图像等）",
          },
          "read-multiple-files": {
            title: "读取多个文件",
            description: "同时读取多个文件",
          },
          "list-directory": {
            title: "目录",
            description: "列出文件夹中的文件和目录",
          },
          "search-files": {
            title: "搜索文件",
            description: "按文件名或内容搜索文件",
          },
          "get-file-info": {
            title: "获取文件信息",
            description: "获取有关文件的详细元数据",
          },
          "edit-file": {
            title: "编辑文件",
            description: "对文本文件进行基于行的编辑。",
          },
          "create-directory": {
            title: "创建目录",
            description: "创建新的目录",
          },
          "move-file": {
            title: "移动/重命名文件",
            description: "移动或重命名文件和目录",
          },
          "copy-file": {
            title: "复制文件",
            description: "复制文件和目录",
          },
          "write-text-file": {
            title: "创建文本文件",
            description: "创建新的文本文件，或覆盖现有的文本文件。",
          },
        },
      },
      createFiles: {
        title: "文档创建",
        description:
          "允许您的代理创建二进制文档格式，例如PowerPoint演示文稿、Excel电子表格、Word文档和PDF文件。文件可以直接从聊天窗口下载。",
        configuration: "可用的文件类型",
        skills: {
          "create-text-file": {
            title: "文本文件",
            description:
              "创建包含任何内容和扩展名的文本文件（如 .txt、.md、.json、.csv 等）。",
          },
          "create-pptx": {
            title: "PowerPoint 演示文稿",
            description: "创建新的幻灯片演示文稿，包括幻灯片、标题和项目符号。",
          },
          "create-pdf": {
            title: "PDF 文档",
            description:
              "使用 Markdown 或纯文本，并进行基本的排版，创建 PDF 文档。",
          },
          "create-xlsx": {
            title: "Excel电子表格",
            description: "创建包含表格数据、工作表和样式的 Excel 文档。",
          },
          "create-docx": {
            title: "Word 文档",
            description: "创建包含基本样式和格式的 Word 文档",
          },
        },
      },
      gmail: {
        title: "Gmail 连接器",
        description:
          "让您的代理能够与Gmail互动：搜索邮件、阅读邮件线程、撰写草稿、发送邮件以及管理您的收件箱。请参考相关文档。",
        multiUserWarning:
          "为了安全原因，在多用户模式下无法使用 Gmail 集成功能。请先禁用多用户模式，然后才能使用此功能。",
        configuration: "Gmail 设置",
        deploymentId: "部署 ID",
        deploymentIdHelp: "您的 Google Apps Script 网页应用的部署 ID",
        apiKey: "API 密钥",
        apiKeyHelp: "您在 Google Apps Script 部署中配置的 API 密钥。",
        configurationRequired: "请配置部署 ID 和 API 密钥，以启用 Gmail 功能。",
        configured: "已配置",
        searchSkills: "搜索技巧...",
        noSkillsFound: "未找到与您的搜索条件匹配的技能。",
        categories: {
          search: {
            title: "搜索和阅读电子邮件",
            description: "搜索并阅读您 Gmail 收件箱中的邮件。",
          },
          drafts: {
            title: "草稿邮件",
            description: "创建、编辑和管理电子邮件草稿",
          },
          send: {
            title: "发送和回复电子邮件",
            description: "立即发送电子邮件并回复讨论串",
          },
          threads: {
            title: "管理电子邮件线程",
            description: "管理邮件线程 - 标记为已读/未读，归档，删除",
          },
          account: {
            title: "集成统计",
            description: "查看邮件收件箱统计数据和账户信息",
          },
        },
        skills: {
          search: {
            title: "搜索邮件",
            description: "使用 Gmail 的查询语法搜索电子邮件",
          },
          readThread: {
            title: "阅读此主题",
            description: "阅读由ID发起的完整邮件往来",
          },
          createDraft: {
            title: "创建草稿",
            description: "创建一个新的电子邮件草稿",
          },
          createDraftReply: {
            title: "创建草稿回复",
            description: "创建一个针对现有主题的回应草稿",
          },
          updateDraft: {
            title: "更新草稿",
            description: "更新已有的电子邮件草稿",
          },
          getDraft: {
            title: "获取草稿",
            description: "通过ID检索特定草稿",
          },
          listDrafts: {
            title: "草稿清单",
            description: "列出所有草稿邮件",
          },
          deleteDraft: {
            title: "删除草稿",
            description: "删除草稿邮件",
          },
          sendDraft: {
            title: "发送草稿",
            description: "发送已有的电子邮件草稿",
          },
          sendEmail: {
            title: "发送电子邮件",
            description: "立即发送一封电子邮件",
          },
          replyToThread: {
            title: "回复主题",
            description: "立即回复邮件线程",
          },
          markRead: {
            title: "马克·瑞德",
            description: "将某个主题标记为已阅读",
          },
          markUnread: {
            title: "标记为未读",
            description: "将某个主题标记为未读",
          },
          moveToTrash: {
            title: "移动到垃圾箱",
            description: "将某个主题归档到垃圾箱",
          },
          moveToArchive: {
            title: "存档",
            description: "存档该主题",
          },
          moveToInbox: {
            title: "移动到收件箱",
            description: "将某个主题移动到收件箱",
          },
          getMailboxStats: {
            title: "邮箱统计",
            description: "获取未读邮件数量和邮箱统计信息",
          },
          getInbox: {
            title: "查看收件箱",
            description: "一种便捷的方式，可以从 Gmail 中获取收件邮件。",
          },
        },
      },
      outlook: {
        title: "Outlook 连接器",
        description:
          "让您的代理通过 Microsoft Graph API 与 Microsoft Outlook 交互——搜索邮件、阅读邮件线程、撰写草稿、发送邮件以及管理您的收件箱。请查阅相关文档。",
        multiUserWarning:
          "由于安全原因，在多用户模式下无法使用 Outlook 集成功能。请先关闭多用户模式，然后再使用此功能。",
        configuration: "Outlook 设置",
        authType: "账户类型",
        authTypeHelp:
          '选择哪些类型的 Microsoft 账户可以进行身份验证。 "所有账户" 支持个人账户和工作/学校账户。 "仅限个人账户" 仅限于个人 Microsoft 账户。 "仅限工作/学校账户" 仅限于特定 Azure AD 租户的工作/学校账户。',
        authTypeCommon: "所有账户（包括个人账户和工作/学习账户）",
        authTypeConsumers: "仅限个人 Microsoft 账户",
        authTypeOrganization: "仅限组织账户 (需要租户 ID)",
        clientId: "申请人（客户）ID",
        clientIdHelp: "您 Azure AD 应用程序注册的应用程序 ID",
        tenantId: "租户 ID",
        tenantIdHelp:
          "您的 Azure AD 应用注册的“租户 ID”。仅在组织内部身份验证时需要。",
        clientSecret: "客户端密钥",
        clientSecretHelp: "您的 Azure AD 应用程序注册的客户端机密值",
        configurationRequired:
          "请配置客户端 ID 和客户端密钥，以便启用 Outlook 相关功能。",
        authRequired:
          "首先保存您的凭据，然后通过 Microsoft 进行身份验证以完成设置。",
        authenticateWithMicrosoft: "使用 Microsoft 身份验证",
        authenticated: "已成功与 Microsoft Outlook 认证。",
        revokeAccess: "撤销权限",
        configured: "已配置",
        searchSkills: "搜索技巧...",
        noSkillsFound: "未找到与您的搜索条件匹配的技能。",
        categories: {
          search: {
            title: "搜索和阅读电子邮件",
            description: "搜索并阅读您 Outlook 收件箱中的电子邮件。",
          },
          drafts: {
            title: "草稿邮件",
            description: "创建、编辑和管理电子邮件草稿",
          },
          send: {
            title: "发送电子邮件",
            description: "立即发送新邮件或回复消息",
          },
          account: {
            title: "集成统计",
            description: "查看邮件收件箱统计数据和账户信息",
          },
        },
        skills: {
          getInbox: {
            title: "查看收件箱",
            description: "从您的 Outlook 收件箱获取最近的邮件",
          },
          search: {
            title: "搜索邮件",
            description: "使用 Microsoft 搜索语法搜索电子邮件",
          },
          readThread: {
            title: "阅读对话",
            description: "阅读完整的电子邮件对话记录",
          },
          createDraft: {
            title: "创建草稿",
            description: "创建一个新的电子邮件草稿，或回复一个已存在的邮件。",
          },
          updateDraft: {
            title: "更新草稿",
            description: "更新已有的电子邮件草稿",
          },
          listDrafts: {
            title: "草稿清单",
            description: "列出所有草稿邮件",
          },
          deleteDraft: {
            title: "删除草稿",
            description: "删除草稿邮件",
          },
          sendDraft: {
            title: "发送草稿",
            description: "发送已有的邮件草稿",
          },
          sendEmail: {
            title: "发送电子邮件",
            description: "立即发送一封新的电子邮件，或回复已存在的消息。",
          },
          getMailboxStats: {
            title: "邮件收件统计",
            description: "获取文件夹数量和邮箱统计信息",
          },
        },
      },
      googleCalendar: {
        title: "Google 日历连接器",
        description:
          "让您的代理能够与 Google 日历互动：查看日历、获取活动、创建和更新活动，以及管理确认回复。请参考相关文档。",
        multiUserWarning:
          "由于安全原因，在多用户模式下无法使用 Google 日历集成功能。请先禁用多用户模式，然后再使用此功能。",
        configuration: "谷歌日历配置",
        deploymentId: "部署ID",
        deploymentIdHelp: "您的 Google Apps Script 网页应用的部署 ID",
        apiKey: "API 密钥",
        apiKeyHelp: "您在 Google Apps Script 部署中配置的 API 密钥。",
        configurationRequired:
          "请配置部署 ID 和 API 密钥，以启用 Google 日历功能。",
        configured: "已配置",
        searchSkills: "搜索技巧...",
        noSkillsFound: "未找到与您搜索条件匹配的技能。",
        categories: {
          calendars: {
            title: "日历",
            description: "查看和管理您的 Google 日历",
          },
          readEvents: {
            title: "查看活动",
            description: "查看和搜索日历活动",
          },
          writeEvents: {
            title: "创建和更新活动",
            description: "创建新的活动，并修改现有的活动。",
          },
          rsvp: {
            title: "请回复确认",
            description: "管理您对活动的响应状态",
          },
        },
        skills: {
          listCalendars: {
            title: "日历列表",
            description: "列出您拥有的或订阅的全部日历。",
          },
          getCalendar: {
            title: "获取日历详情",
            description: "获取有关特定日历的详细信息",
          },
          getEvent: {
            title: "获取活动",
            description: "获取有关特定活动的详细信息",
          },
          getEventsForDay: {
            title: "获取当日活动",
            description: "获取指定日期的所有活动",
          },
          getEvents: {
            title: "获取活动（日期范围）",
            description: "获取指定日期范围内的活动",
          },
          getUpcomingEvents: {
            title: "查看即将举办的活动",
            description: "使用简单的关键词，查找今天、本周或本月的活动",
          },
          quickAdd: {
            title: "快速添加活动",
            description: "从自然语言（例如“明天下午3点开会”）创建一个活动。",
          },
          createEvent: {
            title: "创建活动",
            description: "创建一个新的活动，并完全控制所有属性。",
          },
          updateEvent: {
            title: "活动更新",
            description: "更新现有的日历事件",
          },
          setMyStatus: {
            title: "设置回复状态",
            description: "接受、拒绝或表示初步接受某个活动",
          },
        },
      },
    },
    mcp: {
      title: "MCP 服务器",
      "loading-from-config": "从配置文件加载 MCP 服务器",
      "learn-more": "了解更多关于 MCP 服务器的信息。",
      "no-servers-found": "未找到任何 MCP 服务器",
      "tool-warning": "为了获得最佳性能，建议禁用不必要的工具，以节省上下文。",
      "stop-server": "停止 MCP 服务器",
      "start-server": "启动 MCP 服务器",
      "delete-server": "删除 MCP 服务器",
      "tool-count-warning":
        "这个 MCP 服务器启用了 <b> 工具，这些工具会在每次聊天中使用上下文信息。</b> 建议禁用不需要的工具，以节省上下文。<br />",
      "startup-command": "启动命令",
      command: "命令",
      arguments: "争论",
      "not-running-warning":
        "这个 MCP 服务器目前处于停止状态，可能是因为在启动时出现了错误或被手动停止。",
      "tool-call-arguments": "工具调用的参数",
      "tools-enabled": "工具已启用",
    },
    settings: {
      title: "代理技能设置",
      "max-tool-calls": {
        title: "每个回复的最大请求次数",
        description:
          "单个代理可以使用的最大工具数量，用于生成单个响应。 这样可以防止工具调用数量过多，从而避免无限循环。",
      },
      "intelligent-skill-selection": {
        title: "智能技能选择",
        "beta-badge": "β 版本",
        description:
          "实现无限工具调用，并将每次查询的 Token 使用量最高减少 80%——Athena能够为每个提示自动选择最合适的技能。",
        "max-tools": {
          title: "麦克斯工具",
          description:
            "可以选取的工具的最大数量，用于每个查询。我们建议将此值设置为较高的值，以便在处理大型上下文模型时。",
        },
      },
    },
  },
  recorded: {
    title: "工作区聊天历史记录",
    description: "这些是用户发送的所有聊天记录和消息，按创建日期排序。",
    export: "导出",
    table: {
      id: "编号",
      by: "发送者",
      workspace: "工作区",
      prompt: "提示词",
      response: "响应",
      at: "发送时间",
    },
  },
  customization: {
    interface: {
      title: "界面偏好设置",
      description: "设置您的Athena界面偏好。",
    },
    branding: {
      title: "品牌与白标设置",
      description: "使用自定义品牌对白标您的Athena实例。",
    },
    chat: {
      title: "聊天",
      description: "设置您的Athena聊天偏好。",
      auto_submit: {
        title: "自动提交语音输入",
        description: "在静音一段时间后自动提交语音输入",
      },
      auto_speak: {
        title: "自动语音回复",
        description: "自动朗读 AI 的回复内容",
      },
      spellcheck: {
        title: "启用拼写检查",
        description: "在聊天输入框中启用或禁用拼写检查",
      },
    },
    items: {
      theme: {
        title: "主题",
        description: "选择您偏好的应用配色主题。",
        options: {
          system: "跟随系统",
          light: "浅色",
          dark: "深色",
        },
      },
      "motion-density": {
        title: "动效强度",
        description: "控制页面切换、面板、弹窗和微交互的动画速度与幅度。",
        guide: {
          title: "速度指引",
          description:
            "小圆点会预览当前档位的节奏：移动距离越短越克制快速，移动距离越长越完整明显。",
        },
        options: {
          minimal: {
            label: "轻量",
            description: "动画更短、更安静，适合希望界面稳定少动的使用方式。",
            speed: "快速、克制",
            duration: "约 0.28 秒",
          },
          balanced: {
            label: "平衡",
            description: "默认产品节奏，兼顾精致感、稳定性和安静观感。",
            speed: "标准节奏",
            duration: "约 0.36 秒",
          },
          expressive: {
            label: "丰富",
            description: "动画幅度更完整、更有层次，但仍控制在性能预算内。",
            speed: "更慢、更明显",
            duration: "约 0.48 秒",
          },
        },
      },
      "show-scrollbar": {
        title: "显示滚动条",
        description: "启用或禁用聊天窗口中的滚动条。",
      },
      "support-email": {
        title: "客服邮箱",
        description: "设置用户在需要帮助时可联系的客服邮箱地址。",
      },
      "app-name": {
        title: "名称",
        description: "设置所有用户在登录页面看到的名称。",
      },
      "display-language": {
        title: "显示语言",
        description: "选择显示Athena界面所用的语言（若有翻译可用）。",
      },
      logo: {
        title: "品牌标志",
        description: "上传您的自定义标志以在所有页面展示。",
        add: "添加自定义标志",
        recommended: "推荐尺寸：800 x 200",
        remove: "移除",
        replace: "替换",
      },
      "browser-appearance": {
        title: "浏览器外观",
        description: "自定义应用打开时浏览器标签和标题的外观。",
        tab: {
          title: "标题",
          description: "设置应用在浏览器中打开时的自定义标签标题。",
        },
        favicon: {
          title: "网站图标",
          description: "为浏览器标签使用自定义网站图标。",
        },
      },
      "sidebar-footer": {
        title: "侧边栏底部项目",
        description: "自定义显示在侧边栏底部的项目。",
        icon: "图标",
        link: "链接",
      },
      "render-html": {
        title: "在聊天中渲染 HTML",
        description:
          "在助手回复中呈现 HTML 响应。\n这可以显著提高回复的质量，但也可能带来潜在的安全风险。",
      },
    },
  },
  api: {
    title: "API 密钥",
    description: "API 密钥允许持有者以编程方式访问和管理此Athena实例。",
    link: "阅读 API 文档",
    generate: "生成新的 API 密钥",
    empty: "未找到 API 密钥",
    actions: "操作",
    messages: {
      error: "错误：{{error}}",
    },
    modal: {
      title: "创建新的 API 密钥",
      cancel: "取消",
      close: "关闭",
      create: "创建 API 密钥",
      helper: "创建后，API 密钥可用于以编程方式访问并配置此Athena实例。",
      name: {
        label: "名称",
        placeholder: "生产环境集成",
        helper: "可选。使用一个易于识别的名称，以便之后识别此密钥。",
      },
    },
    row: {
      copy: "复制 API 密钥",
      copied: "已复制",
      unnamed: "--",
      deleteConfirm:
        "确定要停用此 API 密钥吗？\n停用后将无法再使用。\n\n此操作不可撤销。",
    },
    table: {
      name: "名称",
      key: "API 密钥",
      by: "创建者",
      created: "创建时间",
    },
  },
  rerank: {
    title: "重排模型首选项",
    description:
      "配置用于向量检索结果重排的提供商和模型。开启工作区的准确率优化检索后，会使用这里的重排设置。",
    provider: "重排提供商",
    providerHint:
      "默认使用系统自带重排模型。只有在已准备好 DashScope API Key，并希望使用托管 qwen3 重排时，再切换到阿里百炼。",
    providers: {
      native: {
        name: "系统自带重排",
        description:
          "使用Athena内置的本地重排模型，不需要 API Key 或托管接口。",
      },
      alibaba: {
        name: "阿里百炼 DashScope",
        description: "使用阿里云 DashScope qwen3 rerank 重排向量检索结果。",
      },
    },
    model: "重排模型",
    nativeHelp:
      "系统自带重排会使用本地内置模型完成候选片段排序，因此不需要填写 API Key、Base URL 或模型名。在未配置阿里百炼重排前，会优先使用这个默认模式。",
    help: "阿里百炼重排会把向量搜索召回的候选片段发送到 DashScope rerank 接口，根据查询相关性重新排序。请填写 DashScope API Key、Base URL 和模型名。",
    save: "保存更改",
    saving: "正在保存...",
  },
  ocr: {
    title: "OCR 模型首选项",
    description: "配置阅读器用于识别扫描版 PDF 和图片文本的 OCR 提供商和模型。",
    provider: "OCR 提供商",
    providerHint:
      "默认不启用托管 OCR。只有在已准备好 DashScope API Key，并希望使用阿里 OCR 模型处理扫描文本时，再切换到阿里百炼。",
    providers: {
      none: {
        name: "无",
        description: "不使用托管 OCR 模型。扫描版文档不会自动调用外部 OCR。",
      },
      alibaba: {
        name: "阿里百炼 DashScope",
        description: "使用阿里云 DashScope qwen-vl-ocr 识别图片和扫描文本。",
      },
    },
    model: "OCR 模型",
    noneHelp:
      "当前不会调用托管 OCR 模型。阅读器仍可使用已有文本层和本地解析结果，但扫描版 PDF 或图片的 OCR 后处理会保持未配置状态。",
    help: "阿里百炼 OCR 会把需要识别的图像内容发送到 DashScope OpenAI-compatible 接口。请填写 DashScope API Key、Base URL 和模型名。",
    save: "保存更改",
    saving: "正在保存...",
    saved: "OCR 模型设置已保存。",
    saveError: "OCR 模型设置保存失败：{{error}}",
  },
  vision: {
    title: "视觉模型首选项",
    description: "配置用于视觉理解任务的托管视觉模型提供商和模型。",
    provider: "视觉模型提供商",
    providerHint:
      "默认不启用托管视觉模型。只有在已准备好 DashScope API Key，并希望配置阿里视觉模型时，再切换到阿里百炼。",
    providers: {
      none: {
        name: "无",
        description: "不使用托管视觉模型。视觉理解调用会保持未配置状态。",
      },
      alibaba: {
        name: "阿里百炼 DashScope",
        description: "使用阿里云 DashScope Qwen VL 模型进行视觉理解。",
      },
    },
    model: "视觉模型",
    noneHelp:
      "当前没有配置托管视觉模型。这里仅控制全局视觉模型首选项，不会单独改变 OCR 或聊天行为。",
    help: "阿里百炼视觉模型会使用 DashScope OpenAI-compatible 接口。请填写 DashScope API Key、Base URL 和模型名。",
    toolToggle: {
      label: "启用图片预分析",
      description:
        "当聊天消息包含图片时，先用视觉模型分析图片，再把分析结果交给主会话模型。",
      disabledDescription:
        "可以保持开启，但只有配置阿里百炼后才会实际执行图片预分析。",
    },
    save: "保存更改",
    saving: "正在保存...",
    saved: "视觉模型设置已保存。",
    saveError: "视觉模型设置保存失败：{{error}}",
  },
  llm: {
    title: "LLM 首选项",
    description:
      "这些是你首选的 LLM 聊天和嵌入提供商的凭据和设置。请确保这些密钥保持最新且正确，否则Athena将无法正常运行。",
    provider: "LLM 提供商",
    providers: {
      azure_openai: {
        azure_service_endpoint: "Azure 服务端点",
        api_key: "API 密钥",
        chat_deployment_name: "聊天部署名称",
        chat_model_token_limit: "聊天模型令牌限制",
        model_type: "模型类型",
        default: "预设",
        reasoning: "推理",
        model_type_tooltip:
          "如果您的部署使用了推理模型（例如 o1、o1-mini、o3-mini 等），请将此选项设置为“推理”。否则，您的聊天请求可能会失败。",
      },
    },
  },
  provider_preset: {
    title: "条件码导入",
    placeholder: "输入条件码",
    apply: "应用配置",
    applying: "正在应用...",
    imported_status: "已从环境变量导入",
    success_toast:
      "已应用 DeepSeek V4 Pro + 阿里 text-embedding-v4 + 阿里 OCR + 阿里视觉模型配置",
  },
  transcription: {
    title: "转录模型首选项",
    description:
      "这些是你的首选转录模型提供商的凭据和设置。重要的是这些密钥是最新且正确的，否则媒体文件和音频将无法转录。",
    provider: "转录提供商",
    "warn-start":
      "在 RAM 或 CPU 有限的计算机上使用本地 Whisper 模型时，Athena可能会在处理媒体文件时卡住。",
    "warn-recommend": "我们建议至少 2GB RAM 并上传 <10Mb 的文件。",
    "warn-end": "内置模型将在首次使用时自动下载。",
  },
  embedding: {
    title: "Vector Engine",
    "desc-start":
      "Athena Vector Engine 将文档、对话和知识内容转化为可检索的语义向量。",
    "desc-end": "在这里配置支撑索引、语义搜索和知识检索的 embedding 提供商。",
    provider: {
      title: "Vector Engine 提供商",
    },
    "document-mode": {
      title: "文档向量化模式",
      direct: {
        title: "Direct 实时调用",
        description: "文件上传后立即向量化，速度快但成本按实时调用计费。",
      },
      batch: {
        title: "Batch 异步调用（省钱，非实时）",
        description:
          "文件上传后创建异步批处理任务，成本更低，但需要等待任务完成后文档才可被检索。",
      },
      note: "该设置只影响文档入库和工作区重建向量，不影响聊天、搜索和 RAG 查询。",
    },
  },
  "batch-jobs": {
    title: "Batch Jobs / 批处理任务",
    description: "集中查看所有异步文档向量化任务。",
    table: {
      "job-id": "Job ID",
      workspace: "Workspace",
      status: "状态",
      graph: "知识图谱",
      "retry-count": "重试次数",
      "next-retry": "下次重试",
      created: "创建时间",
      updated: "更新时间",
      error: "最后错误",
      action: "操作",
    },
    retry: {
      label: "继续轮询",
      working: "处理中...",
      started: "已恢复批处理任务轮询。",
      failed: "恢复批处理任务轮询失败。",
    },
    graph: {
      status: {
        not_started: "未开始",
        pending: "等待中",
        processing: "处理中",
        completed: "已完成",
        partial_failed: "部分失败",
        failed: "失败",
        unknown: "未知",
      },
    },
  },
  text: {
    title: "文本拆分和分块首选项",
    "desc-start":
      "有时，你可能希望更改新文档在插入到矢量数据库之前拆分和分块的默认方式。",
    "desc-end": "只有在了解文本拆分的工作原理及其副作用时，才应修改此设置。",
    size: {
      title: "文本块大小",
      description: "这是单个向量中可以存在的字符的最大长度。",
      recommend: "嵌入模型的最大长度为",
    },
    overlap: {
      title: "文本块重叠",
      description: "这是在两个相邻文本块之间分块期间发生的最大字符重叠。",
    },
  },
  vector: {
    title: "Vector Engine 存储",
    description:
      "配置 Athena Vector Engine 存储语义向量的位置，为检索与推理提供基础。",
    provider: {
      title: "向量存储提供商",
      description: "LanceDB 不需要任何配置。",
    },
  },
  embeddable: {
    title: "可嵌入的聊天小部件",
    description:
      "可嵌入的聊天小部件是与单个工作区绑定的面向公众的聊天界面。这些允许你构建工作区，然后你可以将其发布到全世界。",
    create: "创建嵌入式对话",
    table: {
      workspace: "工作区",
      chats: "已发送聊天",
      active: "活动域",
      created: "建立",
    },
  },
  "embed-chats": {
    title: "嵌入的聊天历史纪录",
    export: "导出",
    description: "这些是你发布的任何嵌入的所有记录的聊天和消息。",
    table: {
      embed: "嵌入",
      sender: "发送者",
      message: "消息",
      response: "响应",
      at: "发送时间",
    },
  },
  event: {
    title: "事件日志",
    description: "查看此实例上发生的所有操作和事件以进行监控。",
    clear: "清除事件日志",
    table: {
      type: "事件类型",
      user: "用户",
      occurred: "发生时间",
    },
  },
  privacy: {
    title: "隐私和数据处理",
    description: "这是你对连接的第三方提供商和Athena如何处理数据的配置。",
    anonymous: "启用匿名遥测",
  },
  connectors: {
    "search-placeholder": "搜索数据连接器",
    "no-connectors": "未找到数据连接器。",
    github: {
      name: "GitHub 仓库",
      description: "一键导入整个公共或私有的 GitHub 仓库。",
      URL: "GitHub 仓库链接",
      URL_explained: "您希望收集的 GitHub 仓库链接。",
      token: "GitHub 访问令牌",
      optional: "可选",
      token_explained: "用于避免速率限制的访问令牌。",
      token_explained_start: "如果没有 ",
      token_explained_link1: "个人访问令牌",
      token_explained_middle:
        "，由于 GitHub API 的速率限制，可能无法收集所有文件。您可以 ",
      token_explained_link2: "创建临时访问令牌",
      token_explained_end: " 来避免此问题。",
      ignores: "文件忽略列表",
      git_ignore:
        ".gitignore 格式的列表，用于在收集过程中忽略特定文件。输入后按回车保存每一项。",
      task_explained: "完成后，所有文件将可用于在文档选择器中嵌入至工作区。",
      branch: "您希望收集文件的分支。",
      branch_loading: "-- 正在加载可用分支 --",
      branch_explained: "您希望收集文件的分支。",
      token_information:
        "如果未填写 <b>GitHub 访问令牌</b>，由于 GitHub 的公共 API 限制，此数据连接器将只能收集仓库的 <b>顶层</b> 文件。",
      token_personal: "在此处使用 GitHub 账户获取免费的个人访问令牌。",
    },
    gitlab: {
      name: "GitLab 仓库",
      description: "一键导入整个公共或私有的 GitLab 仓库。",
      URL: "GitLab 仓库链接",
      URL_explained: "您希望收集的 GitLab 仓库链接。",
      token: "GitLab 访问令牌",
      optional: "可选",
      token_description: "选择要从 GitLab API 获取的额外实体。",
      token_explained_start: "如果没有 ",
      token_explained_link1: "个人访问令牌",
      token_explained_middle:
        "，由于 GitLab API 的速率限制，可能无法收集所有文件。您可以 ",
      token_explained_link2: "创建临时访问令牌",
      token_explained_end: " 来避免此问题。",
      fetch_issues: "将问题作为文档获取",
      ignores: "文件忽略列表",
      git_ignore:
        ".gitignore 格式的列表，用于在收集过程中忽略特定文件。输入后按回车保存每一项。",
      task_explained: "完成后，所有文件将可用于在文档选择器中嵌入至工作区。",
      branch: "您希望收集文件的分支",
      branch_loading: "-- 正在加载可用分支 --",
      branch_explained: "您希望收集文件的分支。",
      token_information:
        "如果未填写 <b>GitLab 访问令牌</b>，由于 GitLab 的公共 API 限制，此数据连接器将只能收集仓库的 <b>顶层</b> 文件。",
      token_personal: "在此处使用 GitLab 账户获取免费的个人访问令牌。",
    },
    youtube: {
      name: "YouTube 字幕",
      description: "通过链接导入整个 YouTube 视频的转录内容。",
      URL: "YouTube 视频链接",
      URL_explained_start:
        "输入任何 YouTube 视频的链接以获取其转录内容。视频必须启用 ",
      URL_explained_link: "隐藏字幕",
      URL_explained_end: " 功能。",
      task_explained: "完成后，转录内容将可用于在文档选择器中嵌入至工作区。",
    },
    "website-depth": {
      name: "批量链接爬虫",
      description: "爬取一个网站及其指定深度的子链接。",
      URL: "网站链接",
      URL_explained: "您希望爬取的网站链接。",
      depth: "爬取深度",
      depth_explained: "这是爬虫从起始链接向下跟踪的子链接层级数量。",
      max_pages: "最大页面数",
      max_pages_explained: "要爬取的最大链接数。",
      task_explained:
        "完成后，所有抓取的内容将可用于在文档选择器中嵌入至工作区。",
    },
    confluence: {
      name: "Confluence",
      description: "一键导入整个 Confluence 页面。",
      deployment_type: "Confluence 部署类型",
      deployment_type_explained:
        "判断您的 Confluence 实例是部署在 Atlassian 云端还是自托管。",
      base_url: "Confluence 基础链接",
      base_url_explained: "这是您 Confluence 空间的基础链接。",
      space_key: "Confluence 空间标识",
      space_key_explained:
        "您将使用的 Confluence 实例空间标识，通常以 ~ 开头。",
      username: "Confluence 用户名",
      username_explained: "您的 Confluence 用户名",
      auth_type: "Confluence 认证方式",
      auth_type_explained: "选择您希望用于访问 Confluence 页面内容的认证方式。",
      auth_type_username: "用户名和访问令牌",
      auth_type_personal: "个人访问令牌",
      token: "Confluence 访问令牌",
      token_explained_start:
        "您需要提供访问令牌用于认证。您可以在此生成访问令牌",
      token_explained_link: "此处",
      token_desc: "用于认证的访问令牌",
      pat_token: "Confluence 个人访问令牌",
      pat_token_explained: "您的 Confluence 个人访问令牌。",
      task_explained: "完成后，页面内容将可用于在文档选择器中嵌入至工作区。",
      bypass_ssl: "绕过 SSL 证书验证",
      bypass_ssl_explained:
        "启用此选项以绕过对自托管 Confluence 实例的 SSL 证书验证，特别是使用自签名证书的情况。",
    },
    manage: {
      documents: "文档",
      "data-connectors": "数据连接器",
      "desktop-only":
        "这些设置只能在桌面设备上编辑。请使用桌面访问此页面以继续操作。",
      dismiss: "关闭",
      editing: "正在编辑",
    },
    directory: {
      "my-documents": "我的文档",
      "new-folder": "新建文件夹",
      "create-folder-title": "新建文件夹",
      "folder-name": "文件夹名称",
      "folder-name-placeholder": "输入文件夹名称",
      "cancel-create-folder": "取消",
      "create-folder": "创建文件夹",
      "creating-folder": "正在创建...",
      "create-folder-error": "创建文件夹失败。",
      "close-create-folder": "关闭新建文件夹弹窗",
      "search-document": "搜索文档",
      "no-documents": "暂无文档",
      "move-workspace": "移动到工作区",
      "delete-confirmation":
        "您确定要删除这些文件和文件夹吗？\n这将从系统中移除这些文件，并自动将其从所有关联工作区中移除。\n此操作无法撤销。",
      "removing-message":
        "正在删除 {{count}} 个文档和 {{folderCount}} 个文件夹，请稍候。",
      "move-success": "成功移动了 {{count}} 个文档。",
      no_docs: "暂无文档",
      select_all: "全选",
      deselect_all: "取消全选",
      remove_selected: "移除所选",
      save_embed: "保存并嵌入",
      "total-documents_one": "{{count}} 文件",
      "total-documents_other": "{{count}} 类型的文件",
    },
    upload: {
      "processor-offline": "文档处理器不可用",
      "processor-offline-desc":
        "当前文档处理器离线，无法上传文件。请稍后再试。",
      "click-upload": "点击上传或拖放文件",
      "file-types": "支持文本文件、CSV、电子表格、音频文件等！",
      "or-submit-link": "或提交链接",
      "placeholder-link": "https://example.com",
      fetching: "正在获取...",
      "fetch-website": "获取网站",
      "privacy-notice":
        "这些文件将被上传到此Athena实例上的文档处理器。这些文件不会发送或共享给第三方。",
    },
    pinning: {
      what_pinning: "什么是文档固定？",
      pin_explained_block1:
        "当您在Athena中<b>固定</b>一个文档时，我们会将整个文档内容注入到您的提示窗口中，让 LLM 能够完全理解它。",
      pin_explained_block2:
        "这在 <b>大上下文模型</b> 或关键的小文件中效果最佳。",
      pin_explained_block3:
        "如果默认情况下无法从Athena获取满意的答案，固定文档是提高答案质量的好方法。",
      accept: "好的，知道了",
    },
    watching: {
      what_watching: "什么是监控文档？",
      watch_explained_block1:
        "当您在Athena中<b>监控</b>一个文档时，我们会<i>自动</i>按定期间隔从其原始来源同步文档内容。系统会自动更新所有使用该文档的工作区中的内容。",
      watch_explained_block2:
        "此功能当前仅支持在线内容，不适用于手动上传的文档。",
      watch_explained_block3_start: "您可以在 ",
      watch_explained_block3_link: "文件管理器",
      watch_explained_block3_end: " 管理视图中管理被监控的文档。",
      accept: "好的，知道了",
    },
    obsidian: {
      vault_location: "仓库位置",
      vault_description:
        "选择你的 Obsidian 仓库文件夹，以导入所有笔记及其关联。",
      selected_files: "找到 {{count}} 个 Markdown 文件",
      importing: "正在导入保险库…",
      import_vault: "导入保险库",
      processing_time: "根据你的仓库大小，这可能需要一些时间。",
      vault_warning: "为避免冲突，请确保你的 Obsidian 仓库当前未被打开。",
    },
  },
  chat_window: {
    send_message: "发送消息",
    attach_file: "上传或附加文件到当前对话。",
    controls: {
      upload: {
        label: "上传",
        description:
          "上传或附加文件。图片仅随本次对话使用，支持的文档也可以进入工作区知识库。",
        workspaceLabel: "上传文档",
        workspaceDescription:
          "上传文档到当前工作区，方便 Athena 后续组织、检索和引用。",
      },
      quizMode: {
        label: "测试",
        description:
          "开启测试模式。下一条消息会让 Athena 根据你的提示生成测验题。",
        activeDescription: "测试模式已开启。下一条消息将生成测验题。",
      },
      fileAccess: {
        label: "文件访问模式",
        globalDefault: "全局默认",
        modes: {
          sandbox: {
            label: "沙盒模式",
            description: "仅允许访问项目工作区内部文件。",
          },
          authorized: {
            label: "授权模式",
            description: "允许访问已授权的本地目录，例如桌面、文稿和下载。",
          },
          open: {
            label: "完全开放模式",
            description:
              "在确认后允许更广泛的本机文件和终端访问，风险较高，请谨慎使用。",
          },
        },
        openConfirm: {
          title: "开启完全开放文件访问？",
          description:
            "完全开放模式会授予更宽的本地文件访问权限，并可能在批准后执行 shell 命令。",
          confirm: "继续",
        },
      },
    },
    text_size: "更改文字大小。",
    microphone: "语音输入你的提示。",
    send: "将提示消息发送到工作区",
    attachments_processing: "附件正在处理，请稍候……",
    ocr_processing: "OCR 识别中，请稍候……",
    tts_speak_message: "TTS 播报消息",
    copy: "复制",
    regenerate: "重新",
    regenerate_response: "重新回应",
    good_response: "反应良好",
    more_actions: "更多操作",
    metrics_visibility: {
      hover_only: "点击后仅在悬停时显示模型信息",
      always_show: "点击后始终显示模型信息",
    },
    fork: "分叉",
    delete: "删除",
    cancel: "取消",
    edit_prompt: "编辑问题",
    edit_response: "编辑回应",
    preset_reset_description: "清除聊天纪录并开始新的聊天",
    add_new_preset: "新增预设",
    command: "指令",
    your_command: "你的指令",
    placeholder_prompt: "提示范例",
    description: "描述",
    placeholder_description: "描述范例",
    save: "保存",
    small: "小",
    normal: "一般",
    large: "大",
    custom: "自定义",
    custom_text_size: "自定义字体大小",
    workspace_llm_manager: {
      search: "搜索",
      loading_workspace_settings: "正在载入工作区设置",
      available_models: "可用模型",
      available_models_description: "可用模型说明",
      save: "保存",
      saving: "正在保存",
      missing_credentials: "缺少凭证",
      missing_credentials_description: "缺少凭证说明",
    },
    submit: "提交",
    edit_info_user: "“提交”会重新生成 AI 的回复。 “保存”只会更新您的消息。",
    edit_info_assistant: "您所做的修改将直接保存到此处。",
    see_less: "查看更多",
    see_more: "查看更多",
    tools: "工具",
    text_size_label: "字体大小",
    select_model: "选择型号",
    sources: "来源",
    document: "文件",
    similarity_match: "比赛",
    source_count_one: "{{count}} 参考",
    source_count_other: "{{count}} 相关资料",
    preset_exit_description: "停止当前的代理会话",
    add_new: "添加新",
    edit: "编辑",
    publish: "出版",
    stop_generating: "停止生成回复",
    slash_commands: "快捷命令",
    agent_skills: "代理人技能",
    manage_agent_skills: "管理代理人技能",
    agent_skills_disabled_in_session:
      "在活动会话期间，无法修改技能。首先使用 /exit 命令结束会话。",
    start_agent_session: "开始代理会",
    use_agent_session_to_use_tools:
      "您可以通过在提示词的开头使用'@agent'来启动与代理的聊天，从而使用聊天工具。",
    toolTimeline: {
      agentThinking: "Agent 正在思考...",
      agentComplete: "Agent 已完成思考",
      showThoughtChain: "显示思考链",
      hideThoughtChain: "隐藏思考链",
      toolFallback: "工具",
      toolFamilyLabel: "{{family}}（{{toolName}}）",
      actionPrefix: "操作：{{action}} · ",
      status: {
        calling: "正在调用",
        returned: "已返回",
        errored: "调用出错",
        working: "正在处理...",
        finished: "已完成。",
      },
      templates: {
        assemblingToolCall: "正在组装工具调用：{{tool}} {{args}}",
        parsedToolCall: "已解析工具调用：{{tool}} {{args}}",
        toolCall: "工具调用：{{tool}} {{args}}",
        executingTool: "@agent 正在执行 {{tool}} 工具 {{args}}",
        contextFound: "@agent 找到 {{count}} 条可帮助回答问题的补充上下文。",
        toolReturned: "{{tool}} 已返回结果。",
        callingTool: "正在调用 {{tool}}...",
      },
      tools: {
        "rag-memory": "知识库记忆",
        "document-ingest-agent": "文档导入工具",
        "document-summarizer": "文档摘要工具",
        "web-browsing": "网页浏览工具",
        "web-scraping": "网页抓取工具",
        "chat-history": "聊天历史",
        "file-history": "文件历史",
        "shell-agent": "命令行工具",
        "create-chart": "图表生成工具",
        "sql-agent": "SQL 工具",
      },
      toolFamilies: {
        filesystem: "文件工具",
        create: "文件生成工具",
        gmail: "Gmail 工具",
        outlook: "Outlook 工具",
        gcal: "Google 日历工具",
        sql: "SQL 工具",
      },
      actions: {
        search: "搜索",
        store: "存储",
        read: "读取",
        write: "写入",
        create: "创建",
        update: "更新",
        delete: "删除",
        list: "列出",
        get: "获取",
        send: "发送",
        reply: "回复",
        move: "移动",
        mark: "标记",
        query: "查询",
      },
    },
    agent_invocation: {
      model_wants_to_call: "该型号希望进行通话。",
      approve: "批准",
      reject: "拒绝",
      always_allow: "请务必留出 {{skillName}}",
      tool_call_was_approved: "工具使用申请已获得批准。",
      tool_call_was_rejected: "请求获取工具已被拒绝。",
    },
    custom_skills: "定制技能",
    agent_flows: "代理人流动",
    no_tools_found: "未找到匹配的工具",
    loading_mcp_servers: "正在加载 MCP 服务器…",
    app_integrations: "应用程序集成",
    sub_skills: "基本技能",
  },
  profile_settings: {
    edit_account: "编辑帐户",
    profile_picture: "头像",
    remove_profile_picture: "移除头像",
    username: "用户名",
    new_password: "新密码",
    password_description: "密码长度必须至少为 8 个字符",
    cancel: "取消",
    update_account: "更新帐号",
    theme: "主题偏好",
    language: "语言偏好",
    failed_upload: "上传个人资料图片失败：{{error}}",
    upload_success: "个人资料图片已上传。",
    failed_remove: "移除个人资料图片失败：{{error}}",
    profile_updated: "个人资料已更新。",
    failed_update_user: "更新使用者失败：{{error}}",
    account: "帐户",
    email: "邮箱",
    "email-verified": "已验证",
    "email-pending": "待验证",
    "email-unbound": "未绑定",
    "email-bind-hint": "输入邮箱后可发送验证码。",
    "email-change-hint": "输入新邮箱后可发送验证码。",
    "email-required": "邮箱不能为空。",
    "email-code-sent": "验证码已发送。",
    "email-verified-success": "邮箱已验证。",
    "change-email": "修改邮箱",
    "send-verification-code": "发送验证码",
    "resend-verification-code-in": "{{seconds}} 秒后可重发",
    processing: "处理中...",
    support: "支援",
    signout: "登出",
  },
  email_verification_errors: {
    not_found: "没有找到有效验证码，请重新发送验证码。",
    invalid_format: "请输入 6 位数字验证码。",
    expired: "验证码已过期，请重新发送验证码。",
    consumed: "这个验证码已经使用过，请重新发送验证码。",
    attempts_exceeded: "验证码错误次数过多，请重新发送验证码。",
    mismatch: "验证码不正确，请确认使用最新邮件中的验证码。",
    resend_cooldown: "请稍等后再重新发送验证码。",
    smtp_not_configured: "邮箱 SMTP 尚未配置。",
    default: "验证码验证失败，请重新发送后再试。",
  },
  "keyboard-shortcuts": {
    title: "键盘快捷键",
    shortcuts: {
      settings: "打开设置",
      workspaceSettings: "打开目前工作区设置",
      home: "前往首页",
      workspaces: "管理工作区",
      apiKeys: "API 密钥设定",
      llmPreferences: "LLM 偏好设置",
      chatSettings: "聊天设置",
      help: "显示键盘快捷键说明",
      showLLMSelector: "显示工作区 LLM 选择器",
    },
  },
  community_hub: {
    publish: {
      system_prompt: {
        success_title: "成功！",
        success_description: "您的系统提示已发布到社区中心！",
        success_thank_you: "感谢您分享到社群！",
        view_on_hub: "在社区中心查看",
        modal_title: "发布系统提示",
        name_label: "名称",
        name_description: "这是您系统提示的显示名称。",
        name_placeholder: "我的系统提示",
        description_label: "描述",
        description_description:
          "这是您系统提示的描述。用它来描述您系统提示的目的。",
        tags_label: "标签",
        tags_description:
          "标签用于标记您的系统提示，以便于搜索。您可以添加多个标签。最多 5 个标签。每个标签最多 20 个字符。",
        tags_placeholder: "输入并按 Enter 键添加标签",
        visibility_label: "可见性",
        public_description: "公共系统提示对所有人可见。",
        private_description: "私人系统提示仅对您可见。",
        publish_button: "发布到社区中心",
        submitting: "发布中...",
        prompt_label: "提示",
        prompt_description: "这是将用于引导 LLM 的实际系统提示。",
        prompt_placeholder: "在此输入您的系统提示...",
      },
      agent_flow: {
        success_title: "成功！",
        success_description: "您的代理流程已发布到社区中心！",
        success_thank_you: "感谢您分享到社群！",
        view_on_hub: "在社区中心查看",
        modal_title: "发布代理流程",
        name_label: "名称",
        name_description: "这是您代理流程的显示名称。",
        name_placeholder: "我的代理流程",
        description_label: "描述",
        description_description:
          "这是您代理流程的描述。用它来描述您代理流程的目的。",
        tags_label: "标签",
        tags_description:
          "标签用于标记您的代理流程，以便于搜索。您可以添加多个标签。最多 5 个标签。每个标签最多 20 个字符。",
        tags_placeholder: "输入并按 Enter 键添加标签",
        visibility_label: "可见性",
        submitting: "发布中...",
        submit: "发布到社区中心",
        privacy_note:
          "代理流程始终以上传为私有，以保护任何敏感资料。您可以在发布后在社区中心更改可见性。请在发布前验证您的流程不包含任何敏感或私人信息。",
      },
      generic: {
        unauthenticated: {
          title: "需要验证",
          description: "在发布项目之前，您需要通过 Athena 社区中心进行验证。",
          button: "连接到社区中心",
        },
      },
      slash_command: {
        success_title: "成功！",
        success_description: "您的斜线指令已发布到社区中心！",
        success_thank_you: "感谢您分享到社群！",
        view_on_hub: "在社区中心查看",
        modal_title: "发布斜线指令",
        name_label: "名称",
        name_description: "这是您斜线指令的显示名称。",
        name_placeholder: "我的斜线指令",
        description_label: "描述",
        description_description:
          "这是您斜线指令的描述。用它来描述您斜线指令的目的。",
        tags_label: "标签",
        tags_description:
          "标签用于标记您的斜线指令，以便于搜索。您可以添加多个标签。最多 5 个标签。每个标签最多 20 个字符。",
        tags_placeholder: "输入并按 Enter 键添加标签",
        visibility_label: "可见性",
        public_description: "公共斜线指令对所有人可见。",
        private_description: "私人斜线指令仅对您可见。",
        publish_button: "发布到社区中心",
        submitting: "发布中...",
        prompt_label: "提示",
        prompt_description: "这是触发斜线指令时将使用的提示。",
        prompt_placeholder: "在此输入您的提示...",
      },
    },
  },
  security: {
    title: "用户与安全",
    multiuser: {
      title: "多用户模式",
      description: "通过激活多用户模式来设置你的实例以支持你的团队。",
      enable: {
        "is-enable": "多用户模式已启用",
        enable: "启用多用户模式",
        description:
          "默认情况下，你将是唯一的管理员。作为管理员，你需要为所有新用户或管理员创建账户。不要丢失你的密码，因为只有管理员用户可以重置密码。",
        username: "管理员账户用户名",
        password: "管理员账户密码",
      },
    },
    password: {
      title: "密码保护",
      description:
        "用密码保护你的Athena实例。如果你忘记了密码，将无法恢复，所以请务必保存好这个密码。",
      "password-label": "实例密码",
    },
  },
  home: {
    welcome: "欢迎",
    chooseWorkspace: "选择一个工作区开始聊天！",
    notAssigned:
      "你目前还没有分配到任何工作区。\n请联系你的管理员请求访问一个工作区。",
    goToWorkspace: '前往 "{{workspace}}"',
  },
  telegram: {
    title: "Telegram 机器人",
    description:
      "将您的Athena实例与 Telegram 连接起来，这样您就可以从任何设备与您的工作空间进行聊天。",
    setup: {
      step1: {
        title: "第一步：创建您的 Telegram 机器人",
        description:
          "打开 Telegram 上的 @BotFather，发送 `/newbot` 到 <code>@BotFather</code>，按照提示操作，并复制 API 令牌。",
        "open-botfather": "启动 BotFather",
        "instruction-1": "1. 打开链接或扫描二维码",
        "instruction-2":
          "2. 将 <code>/newbot</code> 发送给 <code>@BotFather</code>",
        "instruction-3": "3. 为您的机器人选择一个名称和用户名",
        "instruction-4": "4. 复制您收到的 API 令牌",
      },
      step2: {
        title: "步骤 2：连接您的机器人",
        description:
          "将您从 @BotFather 获得的 API 令牌粘贴到指定位置，并选择一个默认的工作区，以便您的机器人可以进行对话。",
        "bot-token": "机器人代币",
        connecting: "正在连接...",
        "connect-bot": "连接机器人",
      },
      security: {
        title: "推荐的安全设置",
        description: "为了进一步增强安全性，请在 @BotFather 中配置这些设置。",
        "disable-groups": "— 阻止机器人加入群组",
        "disable-inline": "— 阻止机器人被用于内联搜索",
        "obscure-username":
          "使用一个不显眼的机器人用户名，以降低其被发现的可能性。",
      },
      "toast-enter-token": "请您输入一个机器人令牌。",
      "toast-connect-failed": "未能连接机器人。",
    },
    connected: {
      status: "连接",
      "status-disconnected": "未连接—— 令牌可能已过期或无效",
      "placeholder-token": "粘贴新的机器人令牌...",
      reconnect: "重新连接",
      workspace: "工作空间",
      "bot-link": "机器人链接",
      "voice-response": "语音响应",
      disconnecting: "断开连接...",
      disconnect: "断开",
      "voice-text-only": "仅提供文字",
      "voice-mirror": "回声（当用户发送语音时，会以语音形式回复）",
      "voice-always": "请务必在回复中添加语音（发送音频）。",
      "toast-disconnect-failed": "未能成功断开机器人。",
      "toast-reconnect-failed": "机器人连接失败。",
      "toast-voice-failed": "无法更新语音模式。",
      "toast-approve-failed": "未能批准用户。",
      "toast-deny-failed": "未能拒绝用户请求。",
      "toast-revoke-failed": "未能撤销用户权限。",
    },
    users: {
      "pending-description":
        "等待验证的用户。请将此处显示的配对代码与他们在 Telegram 聊天中显示的配对代码进行匹配。",
      unknown: "未知",
    },
  },
  wechat: {
    title: "微信连接器",
    description: "通过腾讯官方 OpenClaw Weixin 二维码扫码连接微信。",
    enabled: {
      title: "启用微信连接器",
      description: "在配置官方桥接能力后，允许当前 Athena 实例使用微信连接器。",
    },
    qr: {
      placeholder: "生成二维码后，用微信扫码完成连接。",
      generate: "生成/刷新二维码",
      alt: "微信登录二维码",
      "open-link-helper": "如果二维码无法扫描，请用浏览器打开以下链接。",
    },
    status: {
      title: "登录状态",
      disconnected: "未连接",
      pending_scan: "等待扫码",
      connected: "已连接",
      expired: "已过期",
      "connected-hint": "已连接，如需重新扫码请先断开连接。",
      "disconnecting-hint": "正在断开并清理 OpenClaw 登录会话...",
    },
    profile: {
      title: "微信用户信息",
      avatar: "微信头像",
      nickname: "昵称",
      wxid: "wxid/openid",
      openid: "openid/account",
      "last-connected": "上次连接",
      placeholder: "暂无",
      "best-effort":
        "资料字段只读取 OpenClaw 元数据；真实凭证仍由 OpenClaw 保存在本地。",
    },
    actions: {
      relogin: "重新登录",
      disconnect: "断开连接",
      disconnecting: "正在断开...",
    },
    toasts: {
      "save-failed": "微信连接器设置保存失败。",
      "qr-failed": "二维码生成失败。",
      "status-failed": "微信登录状态刷新失败。",
      "disconnect-failed": "微信连接器断开失败。",
    },
    errors: {
      openclaw_not_installed:
        "未找到 OpenClaw CLI。请先安装 OpenClaw 或设置 OPENCLAW_BIN。",
      plugin_missing: "尚未安装 OpenClaw Weixin 插件。",
      environment_incomplete: "OpenClaw Weixin 环境不完整或目录不可写。",
      plugin_install_failed: "OpenClaw Weixin 插件安装失败。",
      qr_generation_failed: "微信二维码生成失败。",
      login_status_failed: "微信登录状态读取失败。",
      disconnect_failed: "OpenClaw Weixin 断开失败。",
    },
  },
  advancedGateway: {
    title: "高级连接器",
    description:
      "为 Clawbot、Python、Rust 或其他自定义消息转发服务配置外部 Gateway。",
    enabled: {
      title: "启用高级连接器",
      description: "后续接入外部 Gateway 服务后，允许使用该连接器。",
    },
    notes: {
      title: "Gateway 安全说明",
      "api-secret":
        "API Secret 用于外部 Gateway 调用 Athena webhook 时生成 HMAC 签名。",
      "gateway-url": "Gateway URL 当前用于记录外部 Gateway 服务地址。",
      "no-wechat-state":
        "微信登录态、cookie、token 和本地凭证不会保存在 Athena 中。",
      "external-gateway":
        "真实微信登录、消息接收和消息发送由外部 Gateway、Clawbot 或 OpenClaw 微信插件负责。",
    },
    fields: {
      "gateway-url": "Gateway URL",
      "api-key": "API Key",
      "api-secret": "API Secret",
      "secret-saved": "已保存。留空表示保持不变。",
    },
    actions: {
      test: "测试连接",
      save: "保存配置",
    },
    toasts: {
      saved: "高级连接器设置已保存。",
      tested: "高级连接器测试完成。",
      "save-failed": "高级连接器设置保存失败。",
      "test-failed": "高级连接器测试失败。",
    },
  },
  admin: {
    common: {
      genericError: "错误：{{error}}",
      close: "关闭",
    },
    users: {
      title: "用户",
      description:
        "这里是当前实例内的全部账户。移除用户后将立刻失去该实例访问权限。",
      add: "新增用户",
      table: {
        username: "用户名",
        role: "角色",
        dateAdded: "创建时间",
      },
      roles: {
        default: "普通用户",
        manager: "管理员助理",
        admin: "管理员",
      },
      permissions: {
        title: "权限说明",
        default: [
          "只能在管理员或管理员助理分配的工作区内发送会话。",
          "不能修改任何系统设置。",
        ],
        manager: [
          "可以查看、创建和删除任意工作区，并修改工作区内设置。",
          "可以创建、更新并邀请新用户加入实例。",
          "不可修改 LLM、向量数据库、向量化与其他连接。",
        ],
        admin: ["最高权限用户。", "可查看并执行实例内全部功能。"],
      },
      messageLimit: {
        label: "限制每日消息数",
        description: "将该用户的有效查询或会话次数限制在 24 小时窗口内。",
        inputLabel: "每日消息上限",
      },
      actions: {
        add: "添加用户",
        cancel: "取消",
        update: "更新用户",
        edit: "编辑",
        unsuspend: "恢复",
        suspend: "暂停",
        delete: "删除",
      },
      modal: {
        addTitle: "向实例添加用户",
        editTitle: "编辑 {{username}}",
        usernameLabel: "用户名",
        usernamePlaceholder: "用户的用户名",
        passwordLabel: "密码",
        passwordPlaceholder: "用户初始登录密码",
        passwordHint: "密码必须至少包含 8 个字符",
        passwordNewLabel: "新密码",
        passwordNewPlaceholder: "{{username}} 的新密码",
        bioLabel: "简介",
        bioPlaceholder: "用户简介",
        roleLabel: "角色",
        noteAfterCreate: "创建账号后，用户需使用该初始账号登录后才能访问系统。",
      },
      confirm: {
        suspend: {
          title: "暂停用户？",
          description: "该用户将被登出，并在管理员恢复前无法再次登录。",
          confirm: "暂停",
        },
        unsuspend: {
          title: "恢复用户？",
          description: "该用户将可以重新登录此实例。",
          confirm: "恢复",
        },
        delete: {
          title: "删除用户？",
          description:
            "该用户将被登出，并无法继续使用此 Athena 实例。此操作不可恢复。",
          confirm: "删除",
        },
      },
      toast: {
        suspended: "用户已暂停。",
        unsuspended: "用户已恢复。",
        deleted: "用户已从系统移除。",
      },
    },
    workspaces: {
      title: "实例工作区",
      description:
        "这是当前实例下全部工作区。删除工作区后，其相关聊天与设置也会一并删除。",
      create: "新建工作区",
      table: {
        name: "名称",
        link: "链接",
        users: "用户",
        createdOn: "创建时间",
      },
      modal: {
        createTitle: "创建新工作区",
        create: "创建工作区",
        namePlaceholder: "我的工作区",
        noteAfterCreate: "仅管理员可见新建的工作区，创建后可再分配成员。",
      },
      actions: {
        cancel: "取消",
      },
      confirm: {
        delete: {
          title: "删除工作区？",
          description:
            "{{workspaceName}} 将不再在此 Athena 实例中使用，该操作不可恢复。",
          confirm: "删除",
        },
      },
    },
    invites: {
      title: "邀请",
      description:
        "为组织内成员创建可领取的邀请链接。每条邀请仅能被一个账号使用。",
      create: "创建邀请链接",
      publicRegistration: {
        title: "允许公开注册",
        description: "开启后登录页显示“创建账号”。公开注册仅允许创建普通用户。",
        enabled: "已开启",
        disabled: "已关闭",
        enableAction: "开启",
        disableAction: "关闭",
      },
      table: {
        status: "状态",
        role: "角色",
        acceptedBy: "接受人",
        createdBy: "创建人",
        expires: "到期",
        created: "创建时间",
      },
      noInvitations: "未找到邀请",
      toasts: {
        updateError: "更新公开注册设置失败。",
        updateEnabled: "公开注册已开启。",
        updateDisabled: "公开注册已关闭。",
      },
      modal: {
        title: "创建新邀请",
        roleLabel: "邀请角色",
        copyToast: "邀请链接已复制到剪贴板",
        note: "创建后仅可复制一次完整链接，列表内不再显示 token 明文。",
        expiresLabel: "过期时间",
        role: {
          default: "普通用户",
          manager: "管理员助理",
          admin: "管理员",
        },
        expires: {
          24: "24 小时",
          72: "3 天",
          168: "7 天",
        },
        autoAssignTitle: "自动添加邀请用户到工作区",
        autoAssignDescription:
          "可选：勾选后会在创建时自动将用户加入所选工作区。默认不加入任何工作区。",
        cancel: "取消",
        create: "创建邀请",
        createError: "创建邀请失败，请稍后重试。",
        close: "关闭",
      },
      status: {
        pending: "待使用",
        accepted: "已接受",
        claimed: "已领取",
        revoked: "已失效",
      },
      role: {
        default: "普通用户",
        manager: "管理员助理",
        admin: "管理员",
      },
      deletedUser: "已删除用户",
      confirm: {
        disable: {
          title: "停用邀请？",
          description: "停用后该邀请将不再可用，且操作不可撤销。",
          confirm: "停用",
        },
      },
    },
  },
  scheduledJobs: {
    title: "计划好的任务",
    enableNotifications: "启用浏览器通知，以便及时获取招聘结果",
    description:
      "创建可重复执行的 AI 任务，并设置执行时间表。每个任务会执行一个提示，并可以选择使用辅助工具，然后保存结果供后续审查。",
    newJob: "新工作",
    loading: "正在加载...",
    emptyTitle: "目前没有计划好的任务。",
    emptySubtitle: "创建一个，开始吧。",
    table: {
      name: "姓名",
      schedule: "时间表",
      status: "状态",
      lastRun: "最后一次",
      nextRun: "下一次尝试",
      actions: "行动",
    },
    confirmDelete: "您确定要删除这个已计划的任务吗？",
    toast: {
      deleted: "已删除工作",
      triggered: "工作已成功启动",
      triggerFailed: "未能启动任务",
      triggerSkipped: "目前，这项工作已经开始进行中。",
      killed: "工作已成功停止。",
      killFailed: "未能阻止工作",
    },
    row: {
      neverRun: "切勿奔跑",
      viewRuns: "观看记录",
      runNow: "现在就行动",
      enable: "启用",
      disable: "禁用",
      edit: "编辑",
      delete: "删除",
    },
    modal: {
      titleEdit: "编辑计划任务",
      titleNew: "新建任务",
      nameLabel: "姓名",
      namePlaceholder: "例如：每日新闻摘要",
      promptLabel: "提示",
      promptPlaceholder: "“在每次执行时执行以下指令…”",
      scheduleLabel: "时间表",
      modeBuilder: "建筑师",
      modeCustom: "定制",
      cronPlaceholder: "Cron 表达式（例如：0 9 * * *）",
      currentSchedule: "当前时间表：",
      toolsLabel: "工具（可选）",
      toolsDescription:
        "选择此任务可以使用的任何代理工具。如果未选择任何工具，则任务将不会使用任何工具。",
      toolsSearch: "搜索",
      toolsNoResults: "没有合适的工具",
      required: "必需",
      requiredFieldsBanner: "请务必填写所有必填字段，以便创建职位。",
      cancel: "取消",
      saving: "节省...",
      updateJob: "更新职位",
      createJob: "创建工作",
      jobUpdated: "工作信息已更新",
      jobCreated: "创造了工作",
    },
    builder: {
      fallbackWarning:
        "这个表达式无法通过图形界面进行编辑。请选择“自定义”选项来保留它，或者修改下面的内容来覆盖它。",
      run: "跑步",
      frequency: {
        minute: "每分钟",
        hour: "每小时",
        day: "每日",
        week: "每周",
        month: "每月",
      },
      every: "每一个",
      minuteOne: "1 分钟",
      minuteOther: "{{count}} 分钟",
      atMinute: "在…分",
      pastEveryHour: "过去每个小时",
      at: "在",
      on: "关于",
      onDay: "在某一天",
      ofEveryMonth: "每个月",
      weekdays: {
        sun: "太阳",
        mon: "周一",
        tue: "周二",
        wed: "周三",
        thu: "星期四",
        fri: "周五",
        sat: "星期六",
      },
    },
    runHistory: {
      back: "返回工作列表",
      title: "运行历史：{{name}}",
      schedule: "时间表：",
      emptyTitle: "目前为止，这项工作还没有取得任何成果。",
      emptySubtitle: "立即运行任务，并查看其结果。",
      runNow: "立即行动",
      table: {
        status: "状态",
        started: "开始",
        duration: "时长",
        error: "错误",
      },
      stopJob: "停止工作",
    },
    runDetail: {
      loading: "正在加载运行详情...",
      notFound: "未找到。",
      back: "返回",
      unknownJob: "未知的职位",
      runHeading: "{{name}} — 运行 #{{id}}",
      duration: "时长：{{value}}",
      creating: "创作...",
      threadFailed: "未能创建线程",
      sections: {
        prompt: "提示",
        error: "错误",
        thinking: "想法 ({{count}})",
        toolCalls: "工具调用 ({{count}})",
        files: "文件 ({{count}})",
        response: "回应",
        metrics: "指标",
      },
      metrics: {
        promptTokens: "提示词：",
        completionTokens: "完成标记：",
      },
      stopJob: "停止工作",
      killing: "停止...",
      continueInThread: "继续聊天",
    },
    toolCall: {
      arguments: "论点：",
      showResult: "显示结果",
      hideResult: "隐藏结果",
    },
    file: {
      unknown: "未知的文件",
      download: "下载",
      downloadFailed: "未能下载文件",
      types: {
        powerpoint: "幻灯片",
        pdf: "PDF 格式文档",
        word: "文档",
        spreadsheet: "电子表格",
        generic: "文件",
      },
    },
    status: {
      completed: "已完成",
      failed: "失败",
      timed_out: "超时",
      running: "跑步",
      queued: "排队",
    },
  },
};

export default TRANSLATIONS;
