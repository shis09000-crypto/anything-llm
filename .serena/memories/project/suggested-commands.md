# AnythingLLM - Suggested Commands

## Development Setup
- `yarn setup` — 一键安装所有依赖并初始化数据库 (运行时间较长)

## Development (individual terminals)
- `yarn dev:server` — 启动后端 (localhost:3001, nodemon热重载)
- `yarn dev:frontend` — 启动前端 (localhost:3000, Vite热重载)
- `yarn dev:collector` — 启动文档收集器
- `yarn dev:all` — 同时启动三个服务 (使用 concurrently)

## Production
- `yarn prod:server` — 生产模式启动后端
- `yarn prod:frontend` — 构建前端生产版本

## Database (Prisma)
- `yarn prisma:generate` — 生成 Prisma Client
- `yarn prisma:migrate` — 运行数据库迁移
- `yarn prisma:seed` — 数据库种子填充
- `yarn prisma:setup` — generate + migrate + seed (完整初始化)
- `yarn prisma:reset` — 清空 SQLite 数据库并重新迁移

## Linting & Formatting
- `yarn lint` — 运行全项目 ESLint auto-fix (server + frontend + collector)
- `yarn lint:ci` — 检查 lint (不自动修复，用于 CI)
- 每个子项目也支持: `cd server && yarn lint` / `cd frontend && yarn lint` / `cd collector && yarn lint`

## Testing
- `yarn test` — 运行 Jest 测试 (根级别)
- 测试文件位于 server/__tests__/

## Translation
- `yarn translations:verify` — 验证翻译文件完整性
- `yarn translations:normalize` — 规范化翻译文件
- `yarn translations:prune` — 清理未使用的翻译键
- `yarn translations:create` — 通过 AI 创建新翻译

## Other
- `cd server && yarn swagger` — 生成 Swagger API 文档
- `yarn generate:cloudformation` — 生成 AWS CloudFormation 部署模板

## Note
- 系统是 macOS (Darwin)，标准 Unix 命令均可使用
- 要求 Node.js v18.18.0+ (参考 .nvmrc)
- 包管理: 使用 yarn 而非 npm
