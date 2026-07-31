# CHANGELOG — sdp_ram

## [0.1.0] — 2026-07-27 入库(批次 1, primitive 路径)

- 改写自 templates/comm/ram_2port.v:修端口前缀缺失、initial 初始化阵列(综合器
  静默忽略)、真双口双时钟同址写竞态、无复位;收敛为单时钟 1 写 1 读。
- TB: 643 次读比对 0 失配,含 18 次 read-old 同址碰撞定向检查。
- 达 qualification(决策⑦:原语正确性锚 = 自检 TB);certified 证据链待 P3 逐包推进。
