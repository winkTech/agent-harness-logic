# CHANGELOG — complex_multiplier

## [0.1.0] — 2026-07-27 入库(批次 1, primitive 路径)

- 改写自 templates/comm/cmult.sv:原件四条独立功能缺陷(复数乘法公式错/操作数
  张冠李戴/死寄存器/流水错拍+输入直通);弃三乘法结构改四乘法直算。
- TB: 3138 拍比对(2357 有效拍)0 失配,实测延迟 3 拍。
- 达 qualification(决策⑦:原语正确性锚 = 自检 TB);certified 证据链待 P3 逐包推进。
