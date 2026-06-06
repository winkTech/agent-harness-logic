# Phase 1: 算法分析与架构设计

> 所属工作流: `workflows/hdl-coding-workflow.md`
> 目标: 在写任何代码之前，把算法文档化、设计架构框图、分析每模块难点与风险。

## 1.1 算法文档化

- 数学推导、关键公式、信号流图
- 参数空间、数据率、时钟频率、延迟约束
- 区分"必须满足"和"可以权衡"两类约束
- 输出: `algorithm_spec.md`（参考 `docs/templates/algorithm_spec_template.md`）

## 1.2 RTL 顶层架构框图

- 绘制模块级框图：功能单元划分、数据流向、接口信号
- 标注时钟域、位宽、流水线级数
- **模块与 MATLAB 函数对标**：每个 RTL 模块对应哪个 MATLAB 函数，确保模型和硬件一一对应
- 输出: 架构图（放入 `06_doc/`）

## 1.3 模块设计方案（每个模块逐一分析）

| 项目 | 内容 |
|:-----|:------|
| 接口定义 | 端口列表、协议时序 |
| 实现方案 | 算法→硬件映射（LUT/BRAM/DSP 选择及理由） |
| 难点与风险 | 该模块实现中最难的部分、可能出什么问题 |
| 解决方案 | 针对每个难点的具体对策 |
| 监测机制 | 仿真中如何观测该模块是否正确（断言、计数值、状态监控） |
| 鲁棒性 | 边界输入、反压、溢出、非法状态的处理策略 |

## 1.4 资源约束识别

- 目标器件资源上限（LUT/FF/BRAM/DSP）
- 如有严格资源要求，明确每模块预算上限
- 输出: 初步资源预算表（精确数字在 Phase 2 产出）

## 1.5 浮点参考模型

- MATLAB/Python golden model 构建
- 函数划分对应 RTL 模块架构（与 1.2 框图一致）
- 输出: `golden_model/` 脚本包（`golden_model/src/`, `golden_model/tests/`）

## 1.6 测试向量生成

- 常规数据 / 边界值 / 随机数据 / 特殊模式
- 导出 `.bin` / `.hex` 供 testbench 加载
- 输出: `vectors/*`

## 1.7 性能基线

- 浮点 BER/EVM/NMSE 曲线
- 作为后续定点退化的比对基准

## 检查点

algorithm_spec + 架构框图 + 所有模块方案完成 + golden_model 运行通过。

**参考**: `skills/hdl-coding/references/alg-flow-verilog.md`（代码模板）, `docs/templates/algorithm_spec_template.md`
**输出**: `.claude/state/hdl-coding/project-spec.json`

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_1
```
