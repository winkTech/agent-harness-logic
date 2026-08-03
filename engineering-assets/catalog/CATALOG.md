# CBB/IP Catalog

> Generated from manifest.json and gate-results.json. Do not edit by hand.

Assets: 23 · RED: 0 · YELLOW: 0

## certified

| UID | Version | Kind | Directory | Machine cleared | Blocking | Used by | Badge gap |
|---|---:|---|---|---|---|---|---|
| `axis_skid_buffer` | 1.0.2 | primitive | `cbb/axis_skid_buffer` | certified | — | — | — |
| `cdc_sync` | 1.0.1 | primitive | `cbb/cdc_sync` | certified | — | — | — |
| `channel_est_top` | 1.0.2 | rtl | `cbb/channel_est_top` | certified | — | — | — |
| `complex_multiplier` | 1.0.1 | primitive | `cbb/complex_multiplier` | certified | — | — | — |
| `crc32` | 1.0.1 | primitive | `cbb/crc32` | certified | — | — | — |
| `ddr_axi4_controller` | 1.0.1 | primitive | `cbb/ddr_axi4_controller` | certified | — | — | — |
| `delay_line` | 1.0.1 | primitive | `cbb/delay_line` | certified | — | — | — |
| `frame_sync` | 1.0.1 | primitive | `cbb/frame_sync` | certified | — | — | — |
| `ldpc_codec` | 1.1.0 | rtl | `cbb/ldpc_codec` | certified | — | — | — |
| `lfsr_gen` | 1.0.1 | primitive | `cbb/lfsr_gen` | certified | — | — | — |
| `ofdm_tx_top` | 1.0.1 | rtl | `cbb/ofdm_tx_top` | certified | — | — | — |
| `pulse_merge` | 1.0.2 | rtl | `cbb/pulse_merge` | certified | — | — | board-validation |
| `rrc_polyphase_fir` | 1.0.2 | rtl | `cbb/rrc_polyphase_fir` | certified | — | 1 | board-validation, hold-closure |
| `sdp_ram` | 1.0.1 | primitive | `cbb/sdp_ram` | certified | — | — | — |
| `stream_elastic_pipeline` | 1.0.2 | rtl | `cbb/stream_elastic_pipeline` | certified | — | — | board-validation |
| `sync_top` | 1.0.2 | rtl | `cbb/sync_top` | certified | — | — | — |

## qualification

| UID | Version | Kind | Directory | Machine cleared | Blocking | Used by | Badge gap |
|---|---:|---|---|---|---|---|---|
| `model_comm_rrc` | 1.1.0 | golden-model | `models/comm/rrc` | — | n/a — 非 RTL 门梯适用范围 | 1 | — |
| `pulse_merge_golden` | 0.1.0 | golden-model | `models/comm/pulse_merge` | — | n/a — 非 RTL 门梯适用范围 | 1 | — |
| `stream_elastic_pipeline_golden` | 0.1.0 | golden-model | `models/comm/stream_elastic_pipeline` | — | n/a — 非 RTL 门梯适用范围 | 1 | — |

## intake

| UID | Version | Kind | Directory | Machine cleared | Blocking | Used by | Badge gap |
|---|---:|---|---|---|---|---|---|
| `model_comm_channel_est` | 1.2.0 | golden-model | `models/comm/channel_est` | — | n/a — 非 RTL 门梯适用范围 | 1 | — |
| `model_comm_ldpc` | 1.0.0 | golden-model | `models/comm/ldpc` | — | n/a — 非 RTL 门梯适用范围 | 1 | — |
| `model_comm_ofdm` | 1.2.0 | golden-model | `models/comm/ofdm` | — | n/a — 非 RTL 门梯适用范围 | 1 | — |
| `model_comm_synch` | 1.1.0 | golden-model | `models/comm/synch` | — | n/a — 非 RTL 门梯适用范围 | 1 | — |

## 参考资料根目录（非受治理资产）

以下目录按设计**不登记为 CBB**：存放数据手册与 vendor 上游归档，供查阅与溯源，
不进门梯、不发版本、不取证。**这不是待办项** —— 上方 `RED/YELLOW` 统计不含它们。
（vendor 归档的上游 commit 已全部钉定，见 `integration/registry.json` 各条 `provenance`。）

- `reference-assets/datasheets`
- `reference-assets/vendor`
