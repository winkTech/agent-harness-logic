# Phase 2: 定点量化与资源评估

> 所属工作流: `workflows/hdl-coding-workflow.md`
> 目标: 用数据驱动的方式确定位宽、量化策略和资源预算，杜绝经验估算。

## 2.1 资源目标确认

- 基于 Phase 1.4 的初步预算，确认各模块资源上限
- 如有严格资源要求，在量化阶段就纳入约束

## 2.2 位宽扫描与量化分析

- 各节点从高到低逐级缩减位宽，观察 BER/EVM 退化
- 统计各节点动态范围，确定整数位宽
- 量化策略选择比较：截断(truncation) / 四舍五入(rounding) / 饱和(saturation)
- 量化误差报告：各节点 SNR 退化、最大误差、MSE 汇总

## 2.3 Bit-true 定点模型

- MATLAB `fi()` 重构定点模型
- 与浮点基线逐比特对齐（bit-true）

## 2.4 星座/LUT 映射验证（涉及 LUT 查表时执行）

涉及星座映射、查找表、比特-符号映射的模块必须额外执行：

- **映射公式推导文档化**：从 MATLAB `cnstPattern`/`bi2de` 到 RTL 比特索引的完整推导
- **逐点验证**：对所有可能索引值（如 64QAM 的 64 点）逐一比对 MATLAB 与定点模型的输出
- **固定序列交叉检查**：选 3~5 个已知输入手动核算 I/Q 值
- **输出**: `mapping_verification_report.md`（附验证截图/数据）

> 验证方法示例：MATLAB 输出 `cnstPattern(mapIdx)` → 定点模型输出经 Q(16,9) 缩放后的十六进制值 → 确认与 RTL 预期一致。

## 2.4 资源评估

- DSP/LUT/BRAM 预算表（基于定点结果 + 架构框图，非经验估算）
- 若超标 → 回退 2.2 调整位宽，或回退 Phase 1 调整架构
- 输出架构缩放建议

## 检查点

fixed_point_report + resource_estimate 完成，资源预算在约束内。

**参考**: `skills/hdl-coding/references/alg-flow-verilog.md`（Python 定点函数）, `engineering-assets/knowledge/docs/templates/fixed_point_report_template.md`, `engineering-assets/knowledge/docs/templates/resource_estimate_template.md`
**输出**: `06_doc/fixed_point_report.md` + `06_doc/resource_budget_tracking.md`
**输出**: `fixed_point_report.md`, `resource_estimate.md`

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_2
```
