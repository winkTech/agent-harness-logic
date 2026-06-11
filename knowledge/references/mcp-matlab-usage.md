---
name: mcp-matlab-usage
description: MATLAB MCP Server 使用规范
metadata:
  type: reference
---

# MATLAB MCP Server 使用规范

> 版本: v1.0 | 更新: 2026-06-03

---

## 一、适用边界

### 必须使用 MATLAB MCP 的场景

| 场景 | 说明 |
|------|------|
| MATLAB 脚本/函数执行 | 运行 `.m` 文件、调用 MATLAB 函数 |
| MATLAB 数据分析 | 矩阵运算、信号处理、绘图 |
| Simulink 模型操作 | 模型加载、仿真、参数修改 |
| MATLAB 工作区管理 | 变量读写、工作区查询 |
| 与 MATLAB 交互式调试 | 逐步执行、检查中间结果 |

### 不应使用 MATLAB MCP 的场景

| 场景 | 替代方案 |
|------|----------|
| 简单数值计算 | Python/Bash 直接计算 |
| 批量文件处理 | Bash 脚本 |
| 非 MATLAB 代码执行 | 对应语言的工具链 |
| 纯文本/代码审查 | Read/Grep/Edit 工具 |

---

## 二、触发条件

### 自动触发（高优先级）

当用户请求包含以下关键词或意图时，优先使用 MATLAB MCP：

| 触发词 | 示例 |
|--------|------|
| `matlab` | "用 matlab 跑一下这个脚本" |
| `.m` 文件执行 | "运行 run_all_tests.m" |
| `simulink` | "打开 Simulink 模型" |
| `黄金模型` / `golden model` | "验证 golden model 输出" |
| `仿真` / `simulate` | "仿真 BER 曲线" |
| `定点` / `fixed-point` | "定点化分析" |
| `SNR` / `BER` / `EVM` | "扫描 SNR 看 BER" |
| `星座图` / `眼图` | "画星座图" |
| `滤波器` / `filter` | "设计 RRC 滤波器系数" |

### 手动触发

用户显式要求使用 MATLAB 时触发，如：
- "用 MATLAB 帮我..."
- "在 MATLAB 里运行..."
- "打开 MATLAB 看看..."

---

## 三、与现有工具的协同

```
                ┌─────────────────────────┐
                │     用户请求              │
                └───────────┬─────────────┘
                            │
                    ┌───────▼───────┐
                    │ 涉及 MATLAB?   │
                    └───┬───────┬───┘
                    YES │       │ NO
                ┌───────▼─┐ ┌───▼──────────┐
                │MATLAB MCP│ │Read/Grep/Edit│
                │ 执行/调试 │ │代码审查/编辑  │
                └───────────┘ └──────────────┘
```

| 工具 | 适用 | 不适用 |
|:----|:----|:-----|
| **MATLAB MCP** | 运行 .m 文件、数据生成、绘图、仿真 | 代码审查、静态分析 |
| **Bash + MATLAB CLI** | 批量、CI/CD 场景 | 交互式调试 |
| **Read/Edit/Grep** | 代码阅读、编辑、搜索 | 执行、数值计算 |

---

## 四、典型工作流

### Golden Model 验证

```
1. Read: 审查 MATLAB 源码
2. MATLAB MCP: 运行 run_all_tests.m → 获取 PASS/FAIL
3. MATLAB MCP: 如有失败, 断点调试定位问题
4. Edit: 修复代码
5. MATLAB MCP: 重新运行验证
```

### BER 仿真

```
1. MATLAB MCP: 运行 BER 扫描脚本
2. MATLAB MCP: 获取结果矩阵 + 绘图
3. Read: 对比定点/浮点 BER 差异
4. Edit: 调整定点参数
5. MATLAB MCP: 重新仿真确认
```

### RTL 协同验证

```
1. MATLAB MCP: gen_rtl_test_vectors.m → 生成 .hex 测试向量
2. Bash: 运行 Verilog 仿真
3. MATLAB MCP: 对比 RTL 输出 vs Golden Model 期望
```

---

## 五、注意事项

1. **MCP 首次启动可能较慢** — MATLAB 引擎初始化需要 5-15 秒
2. **MATLAB license 限制** — 确保有可用 license，并发执行受限
3. **路径问题** — MCP 的工作目录默认为当前项目目录，注意 `addpath` 设置
4. **长时仿真** — 超过 60 秒的任务建议使用 `run_in_background`
5. **版本兼容** — 当前环境: MATLAB R2022a + Communications Toolbox + WLAN Toolbox

---

## 六、版本历史

- v1.0 (2026-06-03): 初始版本
