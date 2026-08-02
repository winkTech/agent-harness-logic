# CBB/IP Catalog

> Generated from manifest.json and gate-results.json. Do not edit by hand.

Assets: 23 · RED: 0 · YELLOW: 0

## certified

| UID | Version | Kind | Directory | Machine cleared | Blocking | Used by | Badge gap |
|---|---:|---|---|---|---|---|---|
| `axis_skid_buffer` | 1.0.0 | primitive | `cbb/axis_skid_buffer` | certified | — | — | — |
| `cdc_sync` | 1.0.0 | primitive | `cbb/cdc_sync` | certified | — | — | — |
| `channel_est_top` | 1.0.0 | rtl | `cbb/channel_est_top` | certified | — | — | — |
| `complex_multiplier` | 1.0.0 | primitive | `cbb/complex_multiplier` | certified | — | — | — |
| `crc32` | 1.0.0 | primitive | `cbb/crc32` | certified | — | — | — |
| `ddr_axi4_controller` | 1.0.0 | primitive | `cbb/ddr_axi4_controller` | certified | — | — | — |
| `delay_line` | 1.0.0 | primitive | `cbb/delay_line` | certified | — | — | — |
| `frame_sync` | 1.0.0 | primitive | `cbb/frame_sync` | certified | — | — | — |
| `ldpc_codec` | 1.0.1 | rtl | `cbb/ldpc_codec` | certified | — | — | — |
| `lfsr_gen` | 1.0.0 | primitive | `cbb/lfsr_gen` | certified | — | — | — |
| `ofdm_tx_top` | 1.0.0 | rtl | `cbb/ofdm_tx_top` | certified | — | — | — |
| `pulse_merge` | 1.0.0 | rtl | `cbb/pulse_merge` | certified | — | — | board-validation |
| `rrc_polyphase_fir` | 1.0.1 | rtl | `cbb/rrc_polyphase_fir` | certified | — | 1 | board-validation, hold-closure |
| `sdp_ram` | 1.0.0 | primitive | `cbb/sdp_ram` | certified | — | — | — |
| `stream_elastic_pipeline` | 1.0.0 | rtl | `cbb/stream_elastic_pipeline` | certified | — | — | board-validation |
| `sync_top` | 1.0.0 | rtl | `cbb/sync_top` | certified | — | — | — |

## qualification

| UID | Version | Kind | Directory | Machine cleared | Blocking | Used by | Badge gap |
|---|---:|---|---|---|---|---|---|
| `model_comm_rrc` | 1.1.0 | golden-model | `models/comm/rrc` | — | no gate-results | 1 | — |
| `pulse_merge_golden` | 0.1.0 | golden-model | `models/comm/pulse_merge` | — | no gate-results | 1 | — |
| `stream_elastic_pipeline_golden` | 0.1.0 | golden-model | `models/comm/stream_elastic_pipeline` | — | no gate-results | 1 | — |

## intake

| UID | Version | Kind | Directory | Machine cleared | Blocking | Used by | Badge gap |
|---|---:|---|---|---|---|---|---|
| `model_comm_channel_est` | 1.2.0 | golden-model | `models/comm/channel_est` | — | no gate-results | 1 | — |
| `model_comm_ldpc` | 1.0.0 | golden-model | `models/comm/ldpc` | — | no gate-results | 1 | — |
| `model_comm_ofdm` | 1.2.0 | golden-model | `models/comm/ofdm` | — | no gate-results | 1 | — |
| `model_comm_synch` | 1.1.0 | golden-model | `models/comm/synch` | — | no gate-results | 1 | — |

## Unregistered roots

- `reference-assets/datasheets`
- `reference-assets/vendor`
