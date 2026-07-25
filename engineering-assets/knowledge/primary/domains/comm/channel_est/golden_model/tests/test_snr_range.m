function [pass, detail] = test_snr_range()
    rng(0);  % fix random seed for reproducibility
% 测试4: SNR 范围 — MSE 随 SNR 递增而单调下降
    cfg.N = 64; cfg.N_data = 48; cfg.N_pilot = 4; cfg.M = 16;
    cfg.data_idx = [-26:-22, -20:-8, -6:-1, 1:6, 8:20, 22:26] + 33;
    cfg.pilot_idx = [-21, -7, 7, 21] + 33;
    cfg.channel_type = 'rayleigh'; cfg.fs = 20e6;
    cfg.delay_profiles = [0, 0.2, 0.5, 0.8]*1e-6;
    cfg.path_gains = [0, -3, -6, -10];
    cfg.plot_en = false; cfg.save_vectors = false;

    snr_list = 0:5:30;
    mse_list = zeros(size(snr_list));

    for i = 1:length(snr_list)
        cfg.snr_db = snr_list(i);
        [H_true, Y, X, ~] = sim_channel(cfg);
        pilot_val = X(cfg.pilot_idx);
        [~, H_est] = ls_channel_est(Y, pilot_val, cfg.pilot_idx, cfg.N, 'linear');
        mse_list(i) = 10*log10(mean(abs(H_est - H_true).^2));
    end

    % MSE 应单调下降
    assert(all(diff(mse_list) < 0.5), 'MSE 不单调: %s', mat2str(mse_list, 3));
    % 最高 SNR 处 MSE 应 < -5 dB
    assert(mse_list(end) < -5, 'SNR=30dB MSE=%.1f dB 过高', mse_list(end));
    pass = true;
    detail = sprintf('SNR→MSE: [%s] dB', strjoin(arrayfun(@(x)sprintf('%.1f',x),mse_list,'un',0), ' '));
end
