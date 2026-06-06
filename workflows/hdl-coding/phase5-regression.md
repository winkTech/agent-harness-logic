# Phase 5: 回归 + 覆盖率

> 所属工作流: `workflows/hdl-coding-workflow.md`
> 目标: 确保改动不破坏已有功能，覆盖关键功能场景。

## 回归测试

- 全量运行所有已通过的 Layer，通过 `make regress` 执行
- 回归前确认 baseline clean（`git stash` 未提交修改后再跑）

## 覆盖率

- **mandatory**（核心功能路径）— 要求 100% 触发
- **informative**（边界/异常路径）— 提供覆盖率趋势参考，不阻塞审查

**红线规则**:
- 已有 PASS 的 case 回归不能变 FAIL
- Mandatory 覆盖点 < 100% 不能进审查
- 总体功能覆盖率 < 90% 提示"需评估风险"，不强制阻塞

## Golden Model 覆盖率映射

- 将参考模型的测试用例映射到 covergroup
- 每个测试用例标注覆盖了哪些 covergroup
- 回归报告中显示 "golden model coverage gap"（参考模型跑了但 covergroup 未覆盖的路径）
- 减少"仿真全绿但覆盖率空洞"的风险

## 检查点

回归全绿 + mandatory covergroup 全部触发 + 覆盖率报告已审查。

**关联 Skill/MCP**: `matlab` MCP（Golden Model 覆盖率映射验证）
**数据输入**: `.claude/state/hdl-coding/layer-status.json`（Phase 4 输出，含回归历史）

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_5
```
