function [pass, detail] = test_ls_linear()
    rng(0);  % fix random seed for reproducibility
% 测试1: LS + 线性插值 MSE 验证
    cfg.N = 64; cfg.N_data = 48; cfg.N_pilot = 4; cfg.M = 16;
    cfg.data_idx = [-26:-22, -20:-8, -6:-1, 1:6, 8:20, 22:26] + 33;
    cfg.pilot_idx = [-21, -7, 7, 21] + 33;
    cfg.channel_type = 'rayleigh'; cfg.snr_db = 20; cfg.fs = 20e6;
    cfg.delay_profiles = [0, 0.2, 0.5, 0.8]*1e-6;
    cfg.path_gains = [0, -3, -6, -10];
    cfg.plot_en = false; cfg.save_vectors = false;

    [H_true, Y, X, ~] = sim_channel(cfg);
    pilot_val = X(cfg.pilot_idx);
    [~, H_est] = ls_channel_est(Y, pilot_val, cfg.pilot_idx, cfg.N, 'linear');
    mse = 10*log10(mean(abs(H_est - H_true).^2));
    assert(mse < -10, 'LS+Linear MSE %.1f dB 过高', mse);
    pass = true; detail = sprintf('MSE=%.1f dB', mse);
end
