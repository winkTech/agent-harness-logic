# CHANGELOG — crc32

## [0.1.0] — 2026-07-27 入库(批次 3, primitive 路径)

- 修语义错配:原件非反射 MSB-first 无终值取反,按声称的以太网场景必然失败;
  重写为 IEEE 802.3 反射式(init 0xFFFFFFFF/输入输出反射/终值取反)。
- TB: 36 帧含 IEEE 检验值硬锚 '123456789'→0xCBF43926 + TB 内建软件式逐位模型对照;
  单字节帧/长帧/背靠背帧/复位后首帧一致性实测。
- 达 qualification(决策⑦:原语正确性锚 = 自检 TB);certified 证据链待 P3 逐包推进。
