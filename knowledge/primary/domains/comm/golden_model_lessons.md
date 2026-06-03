---
title: "通信算法 Golden Model 开发经验总结"
version: "1.0"
date: "2026-06-03"
tags: [golden-model, lessons, best-practices, comm, fpga]
---

# 通信算法 Golden Model 开发经验总结

> 覆盖项目: OFDM, RRC(成形滤波), 信道估计, 同步, LDPC
> 覆盖阶段: 算法规格 → MATLAB Golden Model → 定点化 → 资源估算 → RTL → Testbench → 报告

---

## 一、通用教训 (跨项目)

### 1.1 协议/标准验证是第一优先级

**案例 (LDPC)**: 编码器调试了 2 天，尝试了 5+ 种方法（GF(2)高斯消元、SVD零空间、双对角回代），最终发现根因是 **P 矩阵本身是错的**——和 802.11n 标准矩阵完全不一致。

**教训**:
- 在实现任何算法前，**先验证输入数据的正确性**
- 与权威来源对比：标准文档、MATLAB 官方 Toolbox、学术论文中的示例数据
- 一个错误的数据源可以浪费数天的调试时间

### 1.2 知识库先行，代码后行

**案例 (LDPC)**: 用户明确要求"先将知识库空白补全，再根据知识库内容实践"。查阅 WLAN Toolbox 源码后发现正确的 P 矩阵。

**教训**:
- 知识库不是可选文档——它是**实现正确性的前提**
- 每个 golden model 应有完整的 `algorithm_spec.md`
- 编码前确保对协议的数学原理、参数定义、边界条件有清晰理解

### 1.3 善用权威参考实现

**案例 (LDPC)**: MATLAB WLAN Toolbox 的 `ldpcMatrix.m` 包含标准 P 矩阵，`ldpcEncodeCore.m` 揭示了 PT 矩阵编码方法。直接使用这些资源节省了大量时间。

**教训**:
- 不要重新发明轮子——先搜索 MATLAB/开源参考实现
- MATLAB Communications Toolbox、WLAN Toolbox、DSP Toolbox 是宝贵资源
- 参考实现的文档注释往往比标准文档更易理解

### 1.4 7 阶段流水线的价值

所有 5 个项目都采用统一的 7 阶段开发流程：

```
算法规格 → Golden Model → 定点化 → 资源估算 → RTL → Testbench → 报告
```

**每个阶段的产出**：

| 阶段 | 产出 | 关键决策点 |
|:----|:----|:----------|
| 1. 算法规格 | `algorithm_spec.md` | 码参数、公式、接口 |
| 2. Golden Model | `src/*.m`, `run_all_tests.m` | 所有测试通过 |
| 3. 定点化 | `fixed_point_report.md` | Q 格式选择、量化方案 |
| 4. 资源估算 | `resource_estimate.md` | BRAM/LUT/DSP/吞吐率 |
| 5. RTL | `rtl/01_rtl/*.v` | 架构、流水线、状态机 |
| 6. Testbench | `rtl/02_sim/tb_*.v` | MATLAB 协同验证 |
| 7. 报告 | `report_*_fpga_implementation.md` | 完整设计文档 |

**教训**:
- 每个阶段完成后再进入下一阶段——**不要跳步**
- 阶段 2 (Golden Model) 是质量的基石：所有 bug 在 MATLAB 层面修正好
- 阶段 3 (定点化) 的教训最多：定点 bug 最隐蔽

---

## 二、定点化专项教训 (LDPC)

### 2.1 定点化的三个关键参数

| 参数 | 含义 | 示例 Q(10,4) |
|:----|:----|:-----------:|
| B (总位宽) | Total bits including sign | 10 |
| F (小数位) | Fractional bits | 4 |
| 范围 | [-2^(B-F-1), 2^(B-F-1)-2^(-F)] | [-32, 31.9375] |

### 2.2 Bug #1: MAX_INT 公式

```matlab
% ❌ 错误: 多减了 F
MAX_INT = 2^(B - F - 1) - 1;  % Q(10,4): 2^(5)-1 = 31 (应是 511!)

% ✅ 正确: F 不影响整数范围
MAX_INT = 2^(B - 1) - 1;      % Q(10,4): 2^(9)-1 = 511 ✓
                                 % 值 = 511/16 = 31.9375 ✓
```

**教训**: 位宽公式中，小数位 F 只影响分辨率 (SCALE=2^F) 和值域转换 (value = int / SCALE)，不影响整数的最大/最小范围。

### 2.3 Bug #2: sign(0) 问题

```verilog
// ❌ 错误: sign(0) = 0
// 导致 prod_sign = product(signs) = 0
// → 整行 CN 消息清零 → 译码失败

// ✅ 正确: sign(0) 取 +1 (任意非零值)
signs(signs == 0) = 1;  // 定点硬件标准做法
```

**教训**:
- 定点量化后，接近零的值会变成精确零
- `sign(0)` 的数学定义是 0，但硬件中不能这样处理
- 这导致整行 CN→VN 消息为零 → 信息完全丢失

### 2.4 定点调试方法

```
1. 先在高精度测试 (Q(14,8), Q(12,6)) → 确认算法正确
2. 逐步降低精度 → 找到性能断点
3. 逐迭代对比 float vs fixed → 定位首次偏差
4. 检查 sign 错误率 → 2.34% 的 sign 错误导致解码彻底失败
```

---

## 三、RTL 开发专项教训 (OFDM/LDPC/RRC)

### 3.1 HDL 编码规范的重要性

统一的 HDL 编码规范 (hdl-coding skill) 覆盖：
- 时序安全 (同步复位、信号寄存、输出寄存)
- 命名规范 (i_/o_/r_/w_/ri_/ro_ 前缀)
- 状态机设计 (三段式、独热码、default 分支)
- 代码结构和注释

### 3.2 常见 RTL 反模式

| 反模式 | 问题 | 修复 |
|:------|:----|:----|
| 输出用组合逻辑 | 时序违例、glitch | 改为 `ro_` 寄存器 + assign |
| 计数器基于 nxt_state | 逻辑混乱、难调试 | 基于 cur_state 的条件 |
| PASS 转换用复杂条件 | `!a && !b && !c && !d` | 改用显式状态机 |
| 终止条件错误 | `cnt == min1_idx` 而非连接数 | 检查终止语义 |
| 缺少 else/default | 综合出 latch | 每个 if/case 补全 |

### 3.3 模块划分原则

```
ldpc/
├── ldpc_decoder_top.v    ← 顶层: 例化 + AXI 接口
├── ldpc_controller.v     ← 控制: 状态机 + 计数器
├── h_matrix_addr.v       ← 地址: P 矩阵 ROM + 列地址生成
├── cn_update.v           ← 计算: Min-Sum 两遍处理
├── llr_buffer.v          ← 存储: LLR_total BRAM
├── msg_buffer.v          ← 存储: L_r_old BRAM
└── early_term.v          ← 检测: syndrome 早停
```

**原则**:
- 每个模块 ≤ 200 行
- 单一职责: 存储/计算/控制/接口 分离
- 顶层只做例化和接口适配

---

## 四、项目间可复用的模式

### 4.1 通用文件结构 (所有 golden model)

```
<project>/golden_model/
├── config.m              ← 全局参数 (码率、SNR、调制)
├── run_all_tests.m       ← 一键回归测试
├── run_<project>_sim.m   ← 主仿真脚本
├── src/                  ← 核心算法
│   ├── <module1>.m
│   └── <module2>.m
└── tests/                ← 测试套件
    ├── test_<case1>.m
    └── test_<case2>.m
```

### 4.2 测试模式

| 测试类型 | 用途 | 示例 |
|:-------|:----|:----|
| 功能测试 | 基本功能正确性 | `test_encode_decode` |
| 性能测试 | SNR-BER 曲线 | `test_ber_awgn` |
| 边界测试 | 极限条件 | `test_boundary` |
| 对比测试 | 算法 A vs B | `test_min_sum_vs_bp` |
| 收敛测试 | 迭代行为 | `test_convergence` |
| 多帧测试 | 连续处理 | `test_multiple_blocks` |

### 4.3 定点化报告通用模板

```
1. 数值分析 (范围、分布、敏感度)
2. 候选方案 (Q(m,n) 对比表)
3. 精度扫描 (从高到低, 找到断点)
4. 推荐方案 (格式 + 理由)
5. BER 验证 (定点 vs 浮点曲线)
6. 硬件映射 (α 缩放、饱和、位宽扩展)
```

---

## 五、质量门禁

每个阶段完成后的自检清单：

### 阶段 2 (Golden Model)
- [ ] `run_all_tests.m` 全部 PASS
- [ ] 至少 3 种测试类型 (功能/性能/边界)
- [ ] SNR-BER 曲线符合理论预期

### 阶段 3 (定点化)
- [ ] 精度扫描找到断点
- [ ] 推荐格式的 BER 与浮点差异 < 0.2 dB
- [ ] 定点公式 (α 缩放、饱和) 已验证

### 阶段 4 (资源估算)
- [ ] BRAM/LUT/DSP 数量合理
- [ ] 吞吐率满足应用需求
- [ ] 有时序裕量分析

### 阶段 5 (RTL)
- [ ] 所有输入信号已寄存 (ri_)
- [ ] 所有输出通过寄存器 (ro_)
- [ ] 状态机包含 default 分支
- [ ] 无 latch 警告

### 阶段 6 (Testbench)
- [ ] MATLAB 生成测试向量
- [ ] 超时保护
- [ ] 结果自动比对

---

## 六、版本历史

- v1.0 (2026-06-03): 初始版本，汇总 OFDM/RRC/信道估计/同步/LDPC 5 个项目经验
