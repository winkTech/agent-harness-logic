function [pass, detail] = test_ls_dft()
    rng(0);  % 固定种子保证可复现
% 测试7: LS + DFT 插值 — 有效域内验证 (ADR-002: 插值为备选路径)
% DFT 插值的适用前提比线性更严:
%   (1) 导频须为均匀网格 (ifft 的隐含假设) —— 802.11a 的 {-21,-7,7,21}
%       间隔 14/14/14+回绕 22, 非均匀, 不满足; 本测试用均匀网格 {5,21,37,53}
%       (间隔 16) 验证算法本身;
%   (2) 时延扩展 ≤ N_pilot 个可表示抽头 → ≤ 4 样点 (0.2us)。
% 本测试信道 0.15us (3 样点) 同时满足两前提。
    cfg.N = 64; cfg.N_data = 48; cfg.N_pilot = 4; cfg.M = 16;
    cfg.data_idx  = [-26:-22, -20:-8, -6:-1, 1:6, 8:20, 22:26] + 33;
    cfg.pilot_idx = [5, 21, 37, 53];        % 均匀网格, 间隔 16 (算法有效域)
    cfg.channel_type = 'rayleigh'; cfg.snr_db = 20; cfg.fs = 20e6;
    cfg.delay_profiles = [0, 0.05, 0.1, 0.15] * 1e-6;
    cfg.path_gains     = [0, -3, -6, -10];
    cfg.plot_en = false; cfg.save_vectors = false;

    [H_true, Y, X, ~] = sim_channel(cfg);
    pilot_val = X(cfg.pilot_idx);
    [~, H_dft] = ls_channel_est(Y, pilot_val, cfg.pilot_idx, cfg.N, 'dft');

    % 均匀网格下部分 data_idx 被导频覆写, 估计质量仍在全部用载波上度量
    mask = unique([cfg.data_idx, cfg.pilot_idx]);
    mse = 10*log10(mean(abs(H_dft(mask) - H_true(mask)).^2));
    assert(mse < -10, 'LS+DFT (有效域) MSE %.1f dB 过高', mse);
    pass = true; detail = sprintf('MSE=%.1f dB (均匀导频网格)', mse);
end
