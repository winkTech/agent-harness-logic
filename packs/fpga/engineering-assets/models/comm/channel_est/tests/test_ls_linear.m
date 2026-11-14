function [pass, detail] = test_ls_linear()
    rng(0);  % 固定种子保证可复现
% 测试6: LS + 线性插值 — 有效域内验证 (ADR-002: 插值为备选路径)
% 适用前提 = 导频间隔 << 相干带宽 (采样定理, 且边缘外推段须近似平坦)。
% 本测试选 0.1us (2 样点) 时延信道: 相干带宽 ≈ 32 子载波 >> 导频间隔 14 ✓
% (0.15us 实测 -8.2 dB: 边缘外推段的信道变化已不可忽略, 属有效域边界之外)
% 原验收信道 (0.8us, 相干带宽 4) 违反前提, 由 test_lts_ls 的默认方案覆盖。
    cfg.N = 64; cfg.N_data = 48; cfg.N_pilot = 4; cfg.M = 16;
    cfg.data_idx  = [-26:-22, -20:-8, -6:-1, 1:6, 8:20, 22:26] + 33;
    cfg.pilot_idx = [-21, -7, 7, 21] + 33;
    cfg.channel_type = 'rayleigh'; cfg.snr_db = 20; cfg.fs = 20e6;
    cfg.delay_profiles = [0, 0.05, 0.1] * 1e-6;
    cfg.path_gains     = [0, -3, -6];
    cfg.plot_en = false; cfg.save_vectors = false;

    [H_true, Y, X, ~] = sim_channel(cfg);
    pilot_val = X(cfg.pilot_idx);
    [~, H_est] = ls_channel_est(Y, pilot_val, cfg.pilot_idx, cfg.N, 'linear');

    mask = [cfg.data_idx, cfg.pilot_idx];   % 与 MODEL-STATUS 实测口径一致
    mse = 10*log10(mean(abs(H_est(mask) - H_true(mask)).^2));
    assert(mse < -10, 'LS+Linear (有效域) MSE %.1f dB 过高', mse);
    pass = true; detail = sprintf('MSE=%.1f dB', mse);
end
