# Migration 058

按顺序分别执行：

1. `058-01-recharge-integrity-function.sql`
2. `058-02-verification-integrity-function.sql`
3. `058-03-order-integrity-triggers.sql`
4. `058-readonly-verify.sql`

最后两行必须全部为 `READY`。本迁移只恢复当前充值、退费、正常核销和体验核销所需的
数据库状态机与不可变审计字段保护；不要重新执行旧迁移 029，它仍包含已退役的补录核销规则。
