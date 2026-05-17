# AnythingLLM - Task Completion Checklist

完成一个开发任务后，应该执行以下步骤:

1. **代码风格检查**
   - 运行 `yarn lint` 确保 ESLint + Prettier 通过
   - 修复所有 warning（至少确保无 error）
   - 特别检查: 未使用的导入 (unused imports)、未使用变量、未定义变量

2. **测试**
   - 运行 `yarn test` 确保测试通过
   - 如果有相关新功能，添加对应的 Jest 测试
   - 服务器端测试位于 `server/__tests__/`

3. **提交前检查**
   - 已修改文件的 import/require 路径正确
   - 新文件遵循命名约定（server 端 camelCase, 前端组件 PascalCase.jsx）
   - 没有遗留调试代码 (console.log, debugger)
   - Flow 类型注解保持更新
   - 环境变量变更需要更新 `.env.example`

4. **提交信息格式**
   - 简洁的 1-2 句话描述
   - 聚焦于"为什么"而不是"做了什么"
   - 使用常规的 commit 前缀（如 fix:, feat:, chore: 等）

5. **跨模块影响确认**
   - 后端变更 → 检查对应端点/模型是否同步更新
   - 前端变更 → 检查国际化翻译 (locales/) 是否需要更新
   - 数据库变更 → 检查 Prisma schema + migration
   - API 变更 → 检查 Swagger 文档是否需要更新
   - 配置变更 → 确保 .env.example 同步更新

## 常见陷阱
- server 使用 CommonJS (require)，不要用 ESM import
- 前端使用 ES Modules (import/export)
- 不要引入 TypeScript 文件
- API 路径变更需要同步更新前端 API 调用
- 国际化键值变更需要同步所有语言文件
