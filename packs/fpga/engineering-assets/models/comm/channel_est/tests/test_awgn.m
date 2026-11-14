function [pass, detail] = test_awgn()
    rng(0);  % 固定种子保证可复现
% 测试3: AWGN 信道 — 长训练符号 LS 理想估计 (ADR-002 基础)
% H=1, 估计误差纯来自噪声; 2×LTS 平均后理论 MSE ≈ -(SNR+3) dB。
    cfg.N = 64; cfg.N_cp = 16; cfg.fs = 20e6;
    cfg.N_data = 48; cfg.N_pilot = 4; cfg.M = 16;
    cfg.data_idx  = [-26:-22, -20:-8, -6:-1, 1:6, 8:20, 22:26] + 33;
    cfg.pilot_idx = [-21, -7, 7, 21] + 33;
    cfg.channel_type = 'awgn'; cfg.snr_db = 30; cfg.nsym = 1;

    fr = sim_frame(cfg);
    H_est = lts_channel_est(fr.Y_lts, cfg.N);

    mask = [cfg.data_idx, cfg.pilot_idx];
    mse = 10*log10(mean(abs(H_est(mask) - fr.H(mask)).^2));
    assert(mse < -25, 'AWGN 信道 MSE %.1f dB 过高 (理论 ~-33, 门限 -25)', mse);
    pass = true; detail = sprintf('MSE=%.1f dB', mse);
end
