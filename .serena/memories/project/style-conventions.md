# AnythingLLM - Code Style & Conventions

## Naming
- **变量/函数**: camelCase
- **文件命名**: camelCase (server), 但 frontend 组件使用 PascalCase.jsx
- **组件文件**: PascalCase.jsx (frontend/src/components 和 pages)
- **数据库模型**: PascalCase

## Language Features
- JavaScript (ESM modules, `type: "module"` in package.json)
- Server 端也使用 CommonJS (`require`/`module.exports`)
- 使用 Flow 类型注解 (通过 Hermes parser)
- 没有 TypeScript
- JSX 文件使用 `.jsx` 后缀

## Formatting (Prettier)
- 缩进: 2 spaces, no tabs
- 引号: double quotes
- 分号: always (except .config.js files)
- 行宽: 80
- 尾逗号: es5
- 箭头函数括号: always
- endOfLine: lf

## Linting (ESLint)
- 使用 ESLint 9 flat config (`eslint.config.js`)
- Hermes parser (Flow 支持)
- 规则级别: warn (非 error)
- `no-unused-vars`: warn
- `no-undef`: warn (server 端点放宽)
- `no-empty`: warn
- Prettier: warn
- JSX: react 18.2, react-hooks, react-refresh
- `react/prop-types`: off (标记为 FIXME)
- 忽略 `**/*.test.js`
- Unused imports plugin 启用

## Architecture Patterns
- **后端**: Express 路由分 endpoints → models → utils 三层
- **前端**: React 函数组件 + Hooks + Context
- **路由**: React Router v6
- **样式**: TailwindCSS (via Tremor components)
- **状态管理**: React Context (无 Redux)
- **国际化**: i18next + react-i18next
- **API 通信**: fetch-event-source (SSE streaming)
- **测试**: Jest

## Database
- SQLite via Prisma ORM
- Schema: server/prisma/schema.prisma
- Migrations: server/prisma/migrations/

## Important Notes
- 不要使用 TypeScript — 项目使用 Flow 类型注解
- 后端代码在 server/ 下用 require()；根目录 package.json 有 type: "module" 但 server 内不统一使用 ESM
- 所有 PR/提交要求通过 lint 检查
- 配置文件使用无分号风格
- 测试使用 Jest
