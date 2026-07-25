function [pass, detail] = test_awgn()
    rng(0);  % fix random seed for reproducibility
% 测试2: AWGN 信道 — 理想估计 (MSE 应极低)
    cfg.N = 64; cfg.N_data = 48; cfg.N_pilot = 4; cfg.M = 16;
    cfg.data_idx = [-26:-22, -20:-8, -6:-1, 1:6, 8:20, 22:26] + 33;
    cfg.pilot_idx = [-21, -7, 7, 21] + 33;
    cfg.channel_type = 'awgn'; cfg.snr_db = 30; cfg.fs = 20e6;
    cfg.plot_en = false; cfg.save_vectors = false;

    [H_true, Y, X, ~] = sim_channel(cfg);
    pilot_val = X(cfg.pilot_idx);
    [~, H_est] = ls_channel_est(Y, pilot_val, cfg.pilot_idx, cfg.N, 'linear');
    mse = 10*log10(mean(abs(H_est - H_true).^2));
    % AWGN 下 H=I，估计误差来自噪声，高 SNR 应极低
    assert(mse < -30, 'AWGN 信道 MSE %.1f dB 过高', mse);
    pass = true; detail = sprintf('MSE=%.1f dB', mse);
end
