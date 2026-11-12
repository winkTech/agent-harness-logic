# packs/fpga — FPGA 域包

FPGA 域全部内容：规则、技能、agents、工程资产与仿真治理。core 引擎不依赖本包（`HARNESS_PACKS_DISABLED=1` 可整体卸载，P-4 烟测守护）。

## 结构

```
packs/fpga/
  rules/               01-hdl.md（五条红线+Vivado 证据）/ 02-python.md
  skills/              hdl-coding / rtl-gen / project-init / vivado-flow /
                       python-hardware-debug / workflows / xdc-constraint-gen
  agents/              compound（ce-* 评审四件）/ domain（algorithm/logic engineer）
  engineering-assets/  CBB 资产库（certified 源+证据快照+门禁）——详见其 README
  config/              引擎规则表外置（Phase 2.6）：watchdog FPGA 命令 / hdl-gate
                       综合红线 / fix-in-place 变体 / sim-governance / 保护路径
  config.path.sh       shell 侧路径解析（engine 明文设计）
  seed/ docs/ schemas/ references/ tools/
```

## config 规则表（core 骨架 × pack 规则）

core 的 gate/guard 骨架读 `config/*.json`；pack 缺席时骨架降级（不炸、通用逻辑仍生效）。改规则=改 JSON，不动 core。

## 与 core 的边界

- 域词（vivado/rtl/xdc/…）只出现在本包与 `config/` 规则表——C-1 扫描守护 core 纯度。
- 工程资产证据链（certified sha → snapshot → lineage）：改 `engineering-assets` 源文件必须重认证（manifest sha 重算 + `evidence-snapshot --reseal`）。

## 详细文档

工程资产使用与治理见 `engineering-assets/README.md`。
