# CBB/IP Catalog

> Generated from manifest.json and gate-results.json. Do not edit by hand.

Assets: 23 · RED: 8 · YELLOW: 3

## certified

| UID | Version | Kind | Directory | Machine cleared | Blocking | Used by | Badge gap |
|---|---:|---|---|---|---|---|---|
| `axis_skid_buffer` | 1.0.0 | primitive | `cbb/axis_skid_buffer` | certified | — | — | — |
| `ldpc_codec` | 1.0.0 | rtl | `cbb/ldpc_codec` | certified | — | — | G-B-03, G-C-03, signoff, vivado-timing |
| `pulse_merge` | 0.4.0 | rtl | `cbb/pulse_merge` | certified | — | — | board-validation, upstream-commit-unpinned |
| `rrc_polyphase_fir` | 0.4.0 | rtl | `cbb/rrc_polyphase_fir` | certified | — | 1 | board-validation, hold-closure |
| `stream_elastic_pipeline` | 0.4.0 | rtl | `cbb/stream_elastic_pipeline` | certified | — | — | board-validation |

## qualification

| UID | Version | Kind | Directory | Machine cleared | Blocking | Used by | Badge gap |
|---|---:|---|---|---|---|---|---|
| `cdc_sync` | 0.1.0 | primitive | `incubator/intake/cdc_sync` | intake | qualification | — | G-B-03, G-C-01, G-C-02, G-C-04, G-C-05, G-DOC-03, G-DOC-04, G-GATE-01, G-SIGN-01 |
| `complex_multiplier` | 0.1.0 | primitive | `incubator/intake/complex_multiplier` | intake | qualification | — | G-B-03, G-C-01, G-C-02, G-C-04, G-C-05, G-DOC-03, G-DOC-04, G-GATE-01, G-SIGN-01 |
| `crc32` | 0.1.0 | primitive | `incubator/intake/crc32` | intake | qualification | — | G-B-03, G-C-01, G-C-02, G-C-04, G-C-05, G-DOC-03, G-DOC-04, G-GATE-01, G-SIGN-01 |
| `ddr_axi4_controller` | 0.1.0 | primitive | `incubator/intake/ddr_axi4_controller` | intake | qualification | — | G-B-03, G-C-01, G-C-02, G-C-04, G-C-05, G-DOC-03, G-GATE-01, G-SIGN-01 |
| `delay_line` | 0.1.0 | primitive | `incubator/intake/delay_line` | intake | qualification | — | G-B-03, G-C-01, G-C-02, G-C-04, G-C-05, G-DOC-03, G-DOC-04, G-GATE-01, G-SIGN-01 |
| `frame_sync` | 0.1.0 | primitive | `incubator/intake/frame_sync` | intake | qualification | — | G-B-03, G-C-01, G-C-02, G-C-04, G-C-05, G-DOC-03, G-DOC-04, G-GATE-01, G-SIGN-01 |
| `lfsr_gen` | 0.1.0 | primitive | `incubator/intake/lfsr_gen` | intake | qualification | — | G-B-03, G-C-01, G-C-02, G-C-04, G-C-05, G-DOC-03, G-DOC-04, G-GATE-01, G-SIGN-01 |
| `model_comm_rrc` | 1.0.0 | golden-model | `models/comm/rrc` | — | no gate-results | 1 | native-matlab-recheck |
| `pulse_merge_golden` | 0.1.0 | golden-model | `models/comm/pulse_merge` | — | no gate-results | 1 | — |
| `sdp_ram` | 0.1.0 | primitive | `incubator/intake/sdp_ram` | intake | qualification | — | G-B-03, G-C-01, G-C-02, G-C-04, G-C-05, G-DOC-03, G-DOC-04, G-GATE-01, G-SIGN-01 |
| `stream_elastic_pipeline_golden` | 0.1.0 | golden-model | `models/comm/stream_elastic_pipeline` | — | no gate-results | 1 | — |

## intake

| UID | Version | Kind | Directory | Machine cleared | Blocking | Used by | Badge gap |
|---|---:|---|---|---|---|---|---|
| `channel_est_top` | 0.1.0 | rtl | `incubator/intake/channel_est_top` | qualification | certified | — | G-B-03, G-C-01, G-C-02, G-C-04, G-C-05, G-GATE-01, G-SIGN-01, axis-contract, bit-true-vectors, vivado-timing |
| `model_comm_channel_est` | 1.0.0 | golden-model | `models/comm/channel_est` | — | no gate-results | 1 | exported-vectors |
| `model_comm_ldpc` | 1.0.0 | golden-model | `models/comm/ldpc` | — | no gate-results | 1 | exported-vectors |
| `model_comm_ofdm` | 1.0.0 | golden-model | `models/comm/ofdm` | — | no gate-results | 1 | exported-vectors |
| `model_comm_synch` | 1.0.0 | golden-model | `models/comm/synch` | — | no gate-results | 1 | cfo-correction, exported-vectors |
| `ofdm_tx_top` | 0.1.0 | rtl | `incubator/intake/ofdm_tx_top` | qualification | certified | — | G-B-03, G-C-01, G-C-02, G-C-04, G-C-05, G-GATE-01, G-SIGN-01, bit-true-vectors, fft-contract, vivado-timing |
| `sync_top` | 0.1.0 | rtl | `incubator/intake/sync_top` | qualification | certified | — | G-B-03, G-C-01, G-C-02, G-C-04, G-C-05, G-GATE-01, G-SIGN-01, cfo-correction, exported-vectors, vivado-timing |

## Unregistered roots

- `reference-assets/datasheets`
- `reference-assets/vendor`
