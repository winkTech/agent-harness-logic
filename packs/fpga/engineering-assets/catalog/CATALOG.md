# CBB/IP Catalog

> Generated from manifest.json and gate-results.json. Do not edit by hand.

Assets: 28 · RED: 0 · YELLOW: 0

## certified

| UID | Version | Kind | Directory | Machine cleared | Blocking | Used by | Badge gap |
|---|---:|---|---|---|---|---|---|
| `axis_skid_buffer` | 1.0.2 | primitive | `cbb/axis_skid_buffer` | certified | — | — | — |
| `cdc_sync` | 1.0.1 | primitive | `cbb/cdc_sync` | certified | — | — | — |
| `channel_est_top` | 1.0.4 | rtl | `cbb/channel_est_top` | certified | — | — | — |
| `complex_multiplier` | 1.0.1 | primitive | `cbb/complex_multiplier` | certified | — | — | — |
| `cp_remove` | 1.1.1 | rtl | `cbb/cp_remove` | certified | — | — | — |
| `crc32` | 1.0.1 | primitive | `cbb/crc32` | certified | — | — | — |
| `ddr_axi4_controller` | 1.0.1 | primitive | `cbb/ddr_axi4_controller` | certified | — | — | — |
| `delay_line` | 1.0.1 | primitive | `cbb/delay_line` | certified | — | — | — |
| `eq_zf` | 1.1.1 | primitive | `cbb/eq_zf` | certified | — | — | — |
| `fft64_sdf` | 1.0.2 | rtl | `cbb/fft64_sdf` | certified | — | — | — |
| `frame_sync` | 1.0.1 | primitive | `cbb/frame_sync` | certified | — | — | — |
| `ldpc_codec` | 1.1.0 | rtl | `cbb/ldpc_codec` | certified | — | — | — |
| `lfsr_gen` | 1.0.1 | primitive | `cbb/lfsr_gen` | certified | — | — | — |
| `mod_demapper` | 1.0.1 | primitive | `cbb/mod_demapper` | certified | — | — | board-validation |
| `ofdm_tx_top` | 1.0.1 | rtl | `cbb/ofdm_tx_top` | certified | — | — | — |
| `pulse_merge` | 1.0.2 | rtl | `cbb/pulse_merge` | certified | — | — | board-validation |
| `rrc_polyphase_fir` | 1.0.2 | rtl | `cbb/rrc_polyphase_fir` | certified | — | 1 | board-validation, hold-closure |
| `sb_align` | 1.0.0 | primitive | `cbb/sb_align` | certified | — | — | — |
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
| `model_comm_channel_est` | 1.4.0 | golden-model | `models/comm/channel_est` | — | n/a — 非 RTL 门梯适用范围 | 1 | — |
| `model_comm_ldpc` | 1.0.0 | golden-model | `models/comm/ldpc` | — | n/a — 非 RTL 门梯适用范围 | 1 | — |
| `model_comm_ofdm` | 1.8.0 | golden-model | `models/comm/ofdm` | — | n/a — 非 RTL 门梯适用范围 | 3 | — |
| `model_comm_synch` | 1.1.0 | golden-model | `models/comm/synch` | — | n/a — 非 RTL 门梯适用范围 | 1 | — |
