# CBB/IP Catalog

> Generated from manifest.json and gate-results.json. Do not edit by hand.

Assets: 23 · RED: 0 · YELLOW: 0

## certified

| UID | Version | Kind | Directory | Machine cleared | Blocking | Used by | Badge gap |
|---|---:|---|---|---|---|---|---|
| `axis_skid_buffer` | 1.0.0 | primitive | `cbb/axis_skid_buffer` | certified | — | — | — |
| `channel_est_top` | 1.0.0 | rtl | `cbb/channel_est_top` | certified | — | — | — |
| `ldpc_codec` | 1.0.0 | rtl | `cbb/ldpc_codec` | certified | — | — | G-B-03, G-C-03, signoff, vivado-timing |
| `lfsr_gen` | 1.0.0 | primitive | `cbb/lfsr_gen` | certified | — | — | — |
| `ofdm_tx_top` | 1.0.0 | rtl | `cbb/ofdm_tx_top` | certified | — | — | — |
| `pulse_merge` | 0.4.0 | rtl | `cbb/pulse_merge` | certified | — | — | board-validation, upstream-commit-unpinned |
| `rrc_polyphase_fir` | 0.4.0 | rtl | `cbb/rrc_polyphase_fir` | certified | — | 1 | board-validation, hold-closure |
| `stream_elastic_pipeline` | 0.4.0 | rtl | `cbb/stream_elastic_pipeline` | certified | — | — | board-validation |
| `sync_top` | 1.0.0 | rtl | `cbb/sync_top` | certified | — | — | — |

## qualification

| UID | Version | Kind | Directory | Machine cleared | Blocking | Used by | Badge gap |
|---|---:|---|---|---|---|---|---|
| `cdc_sync` | 0.1.0 | primitive | `incubator/intake/cdc_sync` | qualification | certified | — | G-B-03, G-C-01, G-C-02, G-C-04, G-C-05, G-GATE-01, G-SIGN-01 |
| `complex_multiplier` | 0.1.0 | primitive | `incubator/intake/complex_multiplier` | qualification | certified | — | G-B-03, G-C-01, G-C-02, G-C-04, G-C-05, G-GATE-01, G-SIGN-01 |
| `crc32` | 0.1.0 | primitive | `incubator/intake/crc32` | qualification | certified | — | G-B-03, G-C-01, G-C-02, G-C-04, G-C-05, G-GATE-01, G-SIGN-01 |
| `ddr_axi4_controller` | 0.1.0 | primitive | `incubator/intake/ddr_axi4_controller` | qualification | certified | — | G-B-03, G-C-01, G-C-02, G-C-04, G-C-05, G-GATE-01, G-SIGN-01 |
| `delay_line` | 0.1.0 | primitive | `incubator/intake/delay_line` | qualification | certified | — | G-B-03, G-C-01, G-C-02, G-C-04, G-C-05, G-GATE-01, G-SIGN-01 |
| `frame_sync` | 0.1.0 | primitive | `incubator/intake/frame_sync` | qualification | certified | — | G-B-03, G-C-01, G-C-02, G-C-04, G-C-05, G-GATE-01, G-SIGN-01 |
| `model_comm_rrc` | 1.0.0 | golden-model | `models/comm/rrc` | — | no gate-results | 1 | native-matlab-recheck |
| `pulse_merge_golden` | 0.1.0 | golden-model | `models/comm/pulse_merge` | — | no gate-results | 1 | — |
| `sdp_ram` | 0.1.0 | primitive | `incubator/intake/sdp_ram` | qualification | certified | — | G-B-03, G-C-01, G-C-02, G-C-04, G-C-05, G-GATE-01, G-SIGN-01 |
| `stream_elastic_pipeline_golden` | 0.1.0 | golden-model | `models/comm/stream_elastic_pipeline` | — | no gate-results | 1 | — |

## intake

| UID | Version | Kind | Directory | Machine cleared | Blocking | Used by | Badge gap |
|---|---:|---|---|---|---|---|---|
| `model_comm_channel_est` | 1.2.0 | golden-model | `models/comm/channel_est` | — | no gate-results | 1 | — |
| `model_comm_ldpc` | 1.0.0 | golden-model | `models/comm/ldpc` | — | no gate-results | 1 | exported-vectors |
| `model_comm_ofdm` | 1.2.0 | golden-model | `models/comm/ofdm` | — | no gate-results | 1 | exported-vectors |
| `model_comm_synch` | 1.1.0 | golden-model | `models/comm/synch` | — | no gate-results | 1 | — |

## Unregistered roots

- `reference-assets/datasheets`
- `reference-assets/vendor`
