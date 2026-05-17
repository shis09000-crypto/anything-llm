# AnythingLLM Project Overview

## Project Purpose
AnythingLLM 是一个全能型 AI 桌面/自托管应用，可将私有文档转化为聊天机器人。支持多种 LLM、嵌入模型和向量数据库，提供完整的文档管理、工作区、Agent 和 RAG 能力。

## Tech Stack
- **Runtime**: Node.js >=18.18.0
- **Language**: JavaScript (ESM), JSX (React), with Flow 类型注解 (Herme parser)
- **Backend**: Express (ESM, CommonJS hybrid) + Prisma (SQLite)
- **Frontend**: React 18 + Vite + TailwindCSS + React Router v6
- **Formatting**: Prettier (tabWidth 2, singleQuote false, trailingComma es5, printWidth 80)
- **Linting**: ESLint 9 flat config + Prettier plugin
- **Testing**: Jest (root level)
- **Package Manager**: Yarn

## Code Style & Conventions
- 使用 Flow 类型注解（通过 Hermes parser + Flow 工具链）
- JavaScript 文件使用 ES Module（type: "module"），CommonJS (require) 在 server 端混合使用
- JSX 文件使用 .jsx 后缀
- 2 空格缩进，LF 换行，UTF-8 编码
- 双引号（Prettier: singleQuote: false）
- 尾逗号: es5 风格
- 80 列宽限制
- 配置文件 (.config.js) 使用无分号风格
- 使用 `camelCase` 命名变量和函数

## Project Structure
```
anything-llm/
├── server/                 # 后端 Express API
│   ├── endpoints/          # API 路由处理器 (admin, chat, workspace, api, etc.)
│   ├── models/             # 数据模型层
│   ├── prisma/             # Prisma schema + migrations + seed
│   ├── utils/              # 实用工具
│   │   ├── AiProviders/    # 36个 LLM 提供商集成
│   │   ├── agents/         # Agent 系统 (AIBITAT)
│   │   ├── vectorDbProviders/  # 11个向量数据库提供商
│   │   ├── MCP/            # MCP 工具集成
│   │   └── ...
│   ├── jobs/               # 后台任务
│   ├── middleware/         # 中间件
│   ├── storage/            # 持久化存储 (SQLite, 文档, 向量缓存)
│   ├── swagger/            # API 文档
│   └── scripts/            # 维护脚本
├── frontend/               # React SPA
│   ├── src/
│   │   ├── pages/          # 页面组件
│   │   ├── components/     # 通用组件
│   │   ├── hooks/          # 自定义 Hooks
│   │   ├── contexts/       # React Contexts
│   │   ├── locales/        # i18n 翻译文件
│   │   └── models/         # 前端模型
│   └── dist/               # 构建产物
├── collector/              # 文档收集/处理微服务
│   ├── processSingleFile/
│   ├── processLink/
│   ├── processRawText/
│   └── extensions/
├── docker/                 # Docker 部署
├── cloud-deployments/      # 云部署模板 (AWS, GCP, etc.)
└── images/                 # 项目图片资源
```

## Key Features
- 支持 36+ LLM 提供商 (OpenAI, Anthropic, Ollama, Gemini, etc.)
- 支持 11 种向量数据库 (Pinecone, Chroma, Qdrant, Milvus, Weaviate, LanceDB, etc.)
- 多工作区管理
- 文档上传和处理 (PDF, DOCX, XLSX, 图片OCR, 音视频等)
- Agent 系统（支持 MCP 工具、文件系统操作、代码执行）
- Agent 工作流（多步骤自动化流程）
- 嵌入模型支持和批处理
- 用户/权限管理
- 嵌入聊天（iframe/widget）
- 浏览器扩展支持
- Telegram / WeChat 集成
- Web Push 通知
- 定时任务
- 国际化 (i18n - 多语言翻译)
