---
name: security-review-workflow
description: 安全审查流程 — 威胁建模→代码扫描→渗透测试→修复跟踪
version: 1.0.0
agents: [code-reviewer, researcher]
phases: 4
complexity: medium
triggers:
  - authentication implementation
  - API endpoint creation
  - secret/credential handling
  - file upload processing
  - payment/sensitive feature
---

# Security Review Workflow

安全审查的标准操作流程。

---

## Phase 1: 范围与威胁建模

**目的**: 确定审查边界，识别攻击面

1. **确定资产** — 哪些数据/功能需要保护（用户数据、密钥、API token 等）
2. **识别攻击面**:
   - 认证/授权点
   - 用户输入入口
   - 外部 API 调用
   - 文件操作
   - 敏感数据持久化
3. **威胁建模** — 对每个攻击面评估: 威胁类型 → 影响 → 已有防护 → 缺口

**输出**: 威胁模型表（攻击面 × 防护措施）

---

## Phase 2: 自动化扫描

**目的**: 用工具快速发现常见问题

1. **代码扫描**:
   - 硬编码密钥/密码搜索（`grep -E "(api.?key|secret|password|token)\s*[:=]\s*['\"]"`）
   - SQL 注入模式（字符串拼接查库）
   - 危险函数调用（`eval`、`exec`、`shell: true`）
2. **依赖检查** — 确认无已知 CVE 的依赖版本

**输出**: 扫描发现列表

---

## Phase 3: 手动验证

**目的**: 验证无法自动化扫描的逻辑漏洞

1. **认证机制**:
   - Token 存储和传输安全
   - 会话过期和刷新
   - 密码策略
2. **权限控制**:
   - 水平权限越界（用户可以访问他人数据）
   - 垂直权限提升（普通用户可执行管理员操作）
3. **输入验证**:
   - 所有用户输入是否经过校验/清理
   - 文件上传的类型/大小/路径限制
4. **数据保护**:
   - 传输中加密（HTTPS/TLS）
   - 存储加密（敏感字段）
   - 日志中是否泄漏敏感信息

**输出**: 漏洞报告（严重等级 + 复现步骤）

---

## Phase 4: 修复与验证

**目的**: 确保所有发现项得到修复

1. **修复优先级**:
   - 🔴 Critical — 立即修复
   - 🟡 High — 当前迭代修复
   - 🟢 Medium — 下次迭代修复
   - ⚪ Low — 记录待办
2. **修复验证** — 对每个修复确认:
   - 原攻击向量不再有效
   - 修复本身不引入新问题
3. **回归扫描** — 重新运行 Phase 2 自动化扫描

**输出**: 修复确认报告

---

## 关联资源

- [Security Review Skill](../skills/security-review/SKILL.md) — 安全清单和模式
- [Code Review Workflow](../workflows/code-review-workflow.md) — 通用代码审查
