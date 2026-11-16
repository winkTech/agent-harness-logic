---
name: no-direct-push-main
description: 禁止直接推送 main 分支，必须走 PR 流程
metadata:
  type: feedback
---

禁止直接 `git push origin main`。所有提交必须走 PR 流程：
1. 建功能分支 `feat/<描述>` 或 `fix/<描述>`
2. 推送到远端
3. 创建 Pull Request
4. Review 后合入 main

**Why:** 直接推 main 绕过 review 流程，不符合团队协作规范。

**How to apply:** 需要推远端时先创建分支，再 `gh pr create`，不得直接 `git push origin main`。
