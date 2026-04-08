## 1. Implementation

- [x] 1.1 调整认证策略，移除 `default` 无密码登录路径并更新首启行为
- [x] 1.2 设计并落地通知模板的数据模型、读写接口与任务绑定方式
- [x] 1.3 更新任务编辑弹窗，使任务只选择已配置通知模板
- [x] 1.4 为目录选择器增加新建目录能力，并支持创建后立即选择
- [x] 1.5 补充相关测试与回归验证
- [x] 1.6 运行 `openspec validate update-auth-notification-profiles-and-directory-creation --strict`（按用户要求未执行 `pnpm build`）
