---
title: "MATLAB MCP 高效使用指南"
domain: algorithm
tags: [matlab, mcp, golden-model]
created: 2026-06-14
updated: 2026-06-14
difficulty: intermediate
applies_to: algorithm-engineer
---

# MATLAB MCP 高效使用指南

> 通过 MCP 调用 MATLAB 的规范与技巧。让你像在 MATLAB GUI 中一样高效。

---

## 1. MCP 工具映射

| MATLAB 操作 | MCP 方式 | 效率提示 |
|:------------|:---------|:---------|
| 运行脚本 | `run('script.m')` | 确保路径正确 |
| 执行命令 | `eval("command")` | 适合短命令 |
| 读变量 | `eval("disp(var)")` | 配合 `jsonencode` |
| 画图 | `saveas(gcf, 'path.png')` | 保存为 PNG 再查看 |
| 调试 | `dbstop if error` + `run` | 先设断点 |

---

## 2. Golden Model 开发模板

### 2.1 标准步骤

```matlab
% 1. 设置路径
addpath('golden_model/');
addpath('golden_model/utils/');

% 2. 加载配置
config = load_config('config.yaml');  % 自定义

% 3. 运行浮点参考
data_float = ofdm_tx_float(test_input, config);

% 4. 运行定点模型
data_fixed = ofdm_tx_fixed(test_input, config);

% 5. 对比精度
nmse = compute_nmse(data_float, data_fixed);
fprintf('Float vs Fixed NMSE: %.2f dB\n', 10*log10(nmse));
```

### 2.2 测试向量生成

```matlab
% 生成 RTL 测试向量
function gen_test_vectors(config)
    input = generate_random_data(1024, config);
    output = ofdm_tx_fixed(input, config);

    % 保存输入（RTL 驱动用）
    save_hex('tv_in.hex', input, config.bit_width);

    % 保存 golden 输出（RTL 对比用）
    save_hex('tv_golden.hex', output, config.bit_width);

    % 保存定点配置（逻辑工程师参考）
    save_yaml('bit_width.yaml', config);
end
```

---

## 3. 常用命令速查

| 需求 | MCP 命令 |
|:-----|:----------|
| 清空环境 | `eval("clear; close all; clc;")` |
| 装包检查 | `eval("ver")` |
| 查看变量 | `eval("whos")` |
| 加载 mat | `load('data.mat')` |
| 读 CSV | `csvread('file.csv')` |
| 保存图 | `saveas(gcf, 'plot.png')` 然后 Read 图片 |
| 运行测试 | `runtests('tests/')` |
| 检 license | `eval("license('test','Signal_Toolbox')")` |

---

## 4. 避免的陷阱

| 陷阱 | 说明 | 正确做法 |
|:-----|:------|:---------|
| ❌ 长脚本一次性提交 | MCP 超时 ~30s | 分段运行，每段 < 10s |
| ❌ 大矩阵打印到控制台 | `disp(large_matrix)` 爆 buffer | 用 `size()` 检查维度，存文件查看 |
| ❌ 不关 figure | 内存泄漏 | `close all` 在最后执行 |
| ❌ 路径硬编码 | 换机器就挂 | 用 `fullfile()` 构建路径 |
| ❌ `cd` 切换目录 | 后续命令路径错乱 | 用绝对路径或 `addpath` |
