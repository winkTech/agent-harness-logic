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
- [ ] 映射/查表类模块额外检查：
  - [ ] MATLAB 模型优先原则：RTL 映射与模型不一致时是改 RTL 而非改模型
  - [ ] 比特流全程追踪：代码注释中写清了 `bi2de` 位序到 RTL buffer 的对应关系
  - [ ] 全星座点验证通过：所有可能的索引值全覆盖且与模型输出一致
  - [ ] 映射预验证步骤已执行（非仅在 Layer 3 数据通路中验证）
- [ ] Layer 间 Stub（如果有）已标注 TODO，后续替换为完整实现
- [ ] Phase 1 模块设计方案中预见的难点已解决

## 提交审查

用 `code-review` 的 quality 模式执行审查，详见 `workflows/code-review-workflow.md`。

## 升级决策

审查完成后，评估是否需要升级到 architecture-review 或 security-review。
**此决策必须写入数据契约**，供下游工具读取：

```json
{
  "phase": "hdl-coding-phase-6",
  "review_decision": {
    "escalate_architecture": false,
    "escalate_security": false,
    "reason_arch": "",
    "reason_security": ""
  },
  "codebase_metrics": {
    "total_loc": 0,
    "module_count": 0,
    "security_sensitive_hits": 0
  }
}
```

**升级判定规则**：

| 条件 | 触发 | 说明 |
|:-----|:-----|:------|
| 代码量 > 10K LOC | → architecture-review | 模块划分复杂，需要架构级审查 |
| 模块数 > 5 | → architecture-review | 接口交互多，需检查架构一致性 |
| 含 auth/token/secret 等关键词 | → security-review | 涉及敏感数据，需深度安全审查 |
| 含 encrypt/decrypt/cipher | → security-review | 加密实现易出错，需专门审查 |
| 含 payment/upload | → security-review | 金融/文件功能有合规要求 |

**工具检查**：运行 `check_escalation` 自动判断上述条件：
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_escalation
```

## 检查点

审查通过的 RTL + 完整仿真日志 + 覆盖率报告 + **升级决策记录**。

**关联 Skill**: `code-review`（质量审查模式）、`hdl-coding`（时序安全/命名规范核查）
**数据输入**: `.claude/state/hdl-coding/layer-status.json`
**数据输出**（新增）: `.claude/state/hdl-coding/review-decision.json`

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_6
```
