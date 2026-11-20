---
name: matlab
---

# MATLAB 使用知识

> 语法, Simulink, 代码生成

---

## 状态：本域暂无独立文档

原 README 列出的 `syntax.md` / `simulink.md` 从未落地，`../../snippets/` 也不存在
（2026-07-27 PI 审查修正）。MATLAB 相关内容目前分散在下列位置，新增本域文档前
请先确认不与它们重复：

| 内容 | 位置 |
|------|------|
| MATLAB 编码与 Golden Model 规则 | `engineering-assets/knowledge/references/matlab-rule.md` |
| MATLAB↔FPGA 联合工作流（图像处理） | `../fpga/matlab-fpga-image-processing.md` |
| MATLAB↔RTL 协同仿真脚本 | `skills/python-hardware-debug/templates/matlab_cosim.py` |
| Golden Model 工程骨架 | `engineering-assets/knowledge/docs/templates/golden_model_template/` |
| 各通信算法的 Golden Model | `../comm/<算法>/`（ofdm / ldpc / channel_est / synch / convolutional-coding 等） |

---

## ⚠️ 本目录受写入保护

`**/matlab/**` 与 `**/*golden*/**` 在 `engine/scripts/hooks/file-protection-guard.cjs`
的保护清单中。**可以修改，但不能随便修改** —— 每次改动需要用户逐个批准，放行会记入
`var/audit/protected-writes.jsonl`。绕过方式不是关掉门禁，而是走批准通道。

---

## 相关资源

- [MATLAB 官方文档](https://www.mathworks.com/help/matlab/)
- [常见陷阱](../../pitfalls/)
