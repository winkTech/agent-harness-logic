function [pass, detail] = test_lts_ls()
    rng(0);  % 固定种子保证可复现
% 测试1: 长训练符号 LS — 多径验收信道 MSE (ADR-002 默认方案)
% 信道即 MODEL-STATUS §2 的原验收信道 (0.8us 时延扩展, 4 导频插值不可达),
% 长训练符号全用载波 LS 必须达到 MSE < -10 dB。
    cfg = local_cfg();
    cfg.channel_type = 'rayleigh'; cfg.snr_db = 20; cfg.nsym = 1; cfg.M = 16;

    fr = sim_frame(cfg);
    H_est = lts_channel_est(fr.Y_lts, cfg.N);

    mask = [cfg.data_idx, cfg.pilot_idx];   % 与 MODEL-STATUS 实测口径一致
    mse = 10*log10(mean(abs(H_est(mask) - fr.H(mask)).^2));
    assert(mse < -10, 'LTS-LS MSE %.1f dB 过高 (门限 -10)', mse);
    pass = true; detail = sprintf('MSE=%.1f dB', mse);
end

function cfg = local_cfg()
    cfg.N = 64; cfg.N_cp = 16; cfg.fs = 20e6;
    cfg.N_data = 48; cfg.N_pilot = 4;
    cfg.data_idx  = [-26:-22, -20:-8, -6:-1, 1:6, 8:20, 22:26] + 33;
    cfg.pilot_idx = [-21, -7, 7, 21] + 33;
    cfg.delay_profiles = [0, 0.2, 0.5, 0.8] * 1e-6;
    cfg.path_gains     = [0, -3, -6, -10];
end
