# CHANGELOG — ddr_axi4_controller

## [0.1.0] — 2026-07-27 入库(批次 3, primitive 路径)

- 重写修七条缺陷(写通路无数据流接口/awlen-wlast 拍数矛盾/红线 1/2/3/5/
  超时静默/write_nread 命名语义反);TB 内建行为级 AXI4 从机(关联数组存储器+
  随机退避),198 拍读回 0 失配,超时保护与 SLVERR 路径实测。
- 达 qualification(决策⑦:原语正确性锚 = 自检 TB);certified 证据链待 P3 逐包推进。
