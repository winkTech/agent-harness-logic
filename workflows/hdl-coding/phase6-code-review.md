# Phase 6: 代码审查

> 所属工作流: `workflows/hdl-coding-workflow.md`
> 目标: 确认代码质量、风格、以及流程合规性。

## 自审查清单

请在提交审查前逐一确认：

- [ ] 构建系统：Makefile + filelist 已创建，`make lint` / `make compile` 通过
- [ ] 工具链：所有仿真/编译命令使用抽象接口（`make sim` 而非 vsim/vcs 硬编码）
- [ ] 数据对齐：已选定比对模式（周期精确/事务级/Scoreboard），testbench 正确实现
- [ ] 日志可靠：双通道日志（stdout + 文件）+ 完成标记 + 定期 flush
- [ ] 无组合环路
- [ ] 多驱动检查
- [ ] CDC 同步器（两级 reg / 握手 / FIFO）
- [ ] 复位极性一致性
- [ ] 无 lint warning
- [ ] 所有 SVA 断言已启用
- [ ] 参考模型对比通过
- [ ] Layer 间 Stub（如果有）已标注 TODO，后续替换为完整实现
- [ ] Phase 1 模块设计方案中预见的难点已解决

## 提交审查

用 `code-review` 的 quality 模式执行审查，详见 `workflows/code-review-workflow.md`。

## 检查点

审查通过的 RTL + 完整仿真日志 + 覆盖率报告。

**关联 Skill**: `code-review`（质量审查模式）、`hdl-coding`（时序安全/命名规范核查）
**数据输入**: `.claude/state/hdl-coding/layer-status.json`

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_6
```
