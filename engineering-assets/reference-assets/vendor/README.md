# reference-assets/vendor — 第三方上游工程

> **未认证**。本目录下全部内容为第三方上游工程原样归档，仅作参考。
> 未过任何 CBB 准入门（规范 §2），**不得直接复用进产品设计**。
> 需要复用其中某个模块时，走 `incubator/intake` 重新打包并过门禁。

成熟度级别：`reference`（规范 §3.1）。准入判据仅要求
`asset_uid` + `provenance{source,license,retrieved}` + `owner` + 未认证横幅。

## 归档清单

| 目录 | 上游 | 许可 | 文件 | 体积 |
|:--|:--|:--|--:|--:|
| `async_fifo-master/` | github.com/dpretet/async_fifo | MIT | 28 | 101K |
| `axis_udp-main/` | github.com/alknvl/axis_udp | MIT (c) 2022 Alexander | 20 | 309K |
| `basic_verilog-master/` | github.com/pConst/basic_verilog | 见 license/ | 1997 | 66M |
| `picorv32-main/` | github.com/YosysHQ/picorv32 | ISC | 246 | 1.2M |
| `r22sdf-master/` | github.com/nanamake/r22sdf | MIT (c) 2017 Nanamaru Namake | 61 | 4.2M |
| `verilog-pcie-master/` | github.com/alexforencich/verilog-pcie | MIT | 633 | 7.9M |

逐包 provenance 见 `_provenance/<asset_uid>.json`。上游树保持原样不改动，
provenance 集中存放以便与 upstream 重新同步时 diff 干净。

## 已知 provenance 缺口

- 六个包均为 GitHub 分支 ZIP 归档，无 `.git`，**commit SHA 不可复原**；
  `retrieved` 取目录 mtime 作为下界。
- `basic_verilog-master/XilinxBoardStore_with_Alveo_cards_support/`
  为 660 文件 / 33M / 67 张板卡图片，非参考 RTL。如需剔除，必须与
  `git filter-repo` 同窗口执行，否则体积永久留在 history。
