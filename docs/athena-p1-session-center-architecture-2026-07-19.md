# Athena P1 真实会话中心架构升级

## 范围

P1 第一批将 P0 建立的共享 Auth DB `auth_sessions` 接入统一跨设备同步链路。它修复 Web/iOS 过去把 Client Identity 设备记录近似当作登录会话的问题，同时保留设备信任与设备密钥治理的独立边界。

本批不引入 Redis/NATS，不把 Sync V2 变成认证数据库，不改变 JWT 密钥，不把 Session Token 或认证材料放入状态树。

## 权威链路

1. 登录、退出、设备吊销等操作先提交共享 Auth DB；这是会话有效性的唯一权威。
2. 成功写入后计算活动会话集合的 SHA-256 来源修订。修订只包含 session ID、client ID、认证方式、令牌版本和创建时间，不包含令牌、用户身份字段、密码材料或 `lastSeenAt`。
3. 主业务库事务递增 `users/{shadowUserId}/security/sessions`，同时写入 Sync V2 Outbox。相同来源修订不重复递增版本。
4. WS 为主通知；SSE、事件补拉和 manifest 为副链路。Web/iOS 收到节点事件后必须调用 `/api/system/sessions` 权威重验。
5. Auth DB 与主库无法跨库原子提交。独立维护器默认每分钟按账户分页计算来源修订并与 Outbox 最新修订对账，失败时不推进分页；它不占用 Outbox dispatcher，能够恢复登录/吊销成功但通知失败的情况。
6. 过期或已撤销会话保留 30 天后由同一维护周期清理；客户端不依赖清理动作判断会话有效性。

## 公共接口

- `GET /api/system/sessions`：列出当前认证主体的活动会话。
- `POST /api/system/sessions/revoke`：按 session ID 吊销当前主体内的一个会话。
- `POST /api/system/sessions/revoke-others`：保留当前会话，吊销其余会话。
- `POST /api/system/sessions/revoke-all`：吊销当前主体全部会话。

所有写接口要求权威 Session 和高风险请求签名。主体范围只从 `response.locals.authSession` 派生，客户端提交的用户 ID 不参与授权。

## 客户端行为

- Web 会话页并行读取真实会话和设备投影，再以 `clientId` 关联显示名称；旧服务端返回 404/503 时才回退到原设备接口。
- iOS/iPadOS 同时显示“登录会话”和“受信任客户端”，会话吊销与设备撤销不再混用。
- Sync V2 的 sessions 节点采用 `event-cursor + security-revalidate`；缓存只能用于展示，不能授予权限或延长会话。
- 当前会话被吊销后，客户端清除认证状态并回到登录页；游标、缓存和离线队列继续按原账户隔离规则清理。

## 回滚

关闭 Session V2 或回滚服务端时，新表和 Outbox 记录保留。Web 仅在会话 API 明确返回 404/503 时回退到 Client Identity 管理；iOS 设备治理仍可独立使用。任何回滚都不重新签发包含密码材料的旧 JWT。
