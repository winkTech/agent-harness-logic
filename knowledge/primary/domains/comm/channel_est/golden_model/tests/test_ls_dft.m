function [pass, detail] = test_ls_dft()
    rng(0);  % fix random seed for reproducibility
% 测试2: LS + DFT 插值 MSE 验证 (应优于线性)
    cfg.N = 64; cfg.N_data = 48; cfg.N_pilot = 4; cfg.M = 16;
    cfg.data_idx = [-26:-22, -20:-8, -6:-1, 1:6, 8:20, 22:26] + 33;
    cfg.pilot_idx = [-21, -7, 7, 21] + 33;
    cfg.channel_type = 'rayleigh'; cfg.snr_db = 20; cfg.fs = 20e6;
    cfg.delay_profiles = [0, 0.2, 0.5, 0.8]*1e-6;
    cfg.path_gains = [0, -3, -6, -10];
    cfg.plot_en = false; cfg.save_vectors = false;

    [H_true, Y, X, ~] = sim_channel(cfg);
    pilot_val = X(cfg.pilot_idx);
    [~, H_lin] = ls_channel_est(Y, pilot_val, cfg.pilot_idx, cfg.N, 'linear');
    [~, H_dft] = ls_channel_est(Y, pilot_val, cfg.pilot_idx, cfg.N, 'dft');

    mse_lin = mean(abs(H_lin - H_true).^2);
    mse_dft = mean(abs(H_dft - H_true).^2);
    assert(mse_dft < mse_lin, 'DFT 未优于线性: DFT=%.2f, Lin=%.2f', ...
        10*log10(mse_dft), 10*log10(mse_lin));
    pass = true; detail = sprintf('DFT MSE=%.1f dB (Lin=%.1f dB)', ...
        10*log10(mse_dft), 10*log10(mse_lin));
end
