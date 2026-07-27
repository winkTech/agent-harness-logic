# Phase 8: 报告输出（原 Phase 7）

> 所属工作流: `workflows/hdl-coding-workflow.md`
> 目标: 汇总各阶段文档，形成可交付的完整设计包，记录经验教训。

---

## 实现报告

输出 `report_*_fpga_implementation.md`，包含：

- 架构框图决策说明
- 定点量化结果汇总（位宽表、量化误差）
- **全链验证矩阵**（Phase 4 每模块验证结果 + Phase 5 全链对比结果）
- 资源评估结果（DSP/LUT/BRAM 实际 vs 预算）
- 性能指标（BER/EVM 退化率）
- 难点解决方案回顾

---

## 文档归档

整理所有阶段产物的链接：

| 阶段 | 产物 | 路径 |
|:----|:-----|:------|
| Phase 1 | 算法规格 + architecture.yaml | `algorithm_spec.md` |
| Phase 1 | Golden Model | `golden_model/` |
| Phase 2 | 定点报告 | `fixed_point_report.md` |
| Phase 2 | 资源评估 | `resource_estimate.md` |
| Phase 3 | 测试向量 | `02_sim/tv/` |
| Phase 4 | RTL 源码 + 验证矩阵 | `01_src/` |
| Phase 5 | 全链仿真报告 | `logs/top_level_sim.log` |
| Phase 6 | 回归/覆盖率报告 | `coverage_report/` |
| Phase 7 | 代码审查报告 | `review_report.md` |

---

## 经验记录

- 关键决策、踩坑记录
- 记录到 `memory/learnings/` 或项目文档
- 供后续算法模块参考

---

## 检查点

报告完成，文档归档，经验已记录。

**参考**: `skills/workflows/hdl-coding-workflow.md`（Phase 列表与检查点体系）, `engineering-assets/knowledge/docs/templates/report_template.md`

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_8
```
