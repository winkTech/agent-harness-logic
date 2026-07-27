function [pass, detail] = test_mod_order()
    rng(0);  % fix random seed for reproducibility
% 测试5: 调制阶数 — QPSK/16QAM/64QAM 兼容性验证
    cfg.N = 64; cfg.N_data = 48; cfg.N_pilot = 4;
    cfg.data_idx = [-26:-22, -20:-8, -6:-1, 1:6, 8:20, 22:26] + 33;
    cfg.pilot_idx = [-21, -7, 7, 21] + 33;
    cfg.channel_type = 'rayleigh'; cfg.snr_db = 25; cfg.fs = 20e6;
    cfg.delay_profiles = [0, 0.2, 0.5, 0.8]*1e-6;
    cfg.path_gains = [0, -3, -6, -10];
    cfg.plot_en = false; cfg.save_vectors = false;

    mods = {'qpsk', '16qam', '64qam'};
    mod_M = [4, 16, 64];
    mse_list = zeros(length(mods), 1);

    for i = 1:length(mods)
        cfg.mod = mods{i}; cfg.M = mod_M(i);
        [H_true, Y, X, ~] = sim_channel(cfg);
        pilot_val = X(cfg.pilot_idx);
        [~, H_est] = ls_channel_est(Y, pilot_val, cfg.pilot_idx, cfg.N, 'linear');
        mse_list(i) = 10*log10(mean(abs(H_est - H_true).^2));
    end

    % 三种调制 MSE 差异应 < 3 dB
    for i = 1:length(mse_list)
        assert(mse_list(i) < -8, '%s MSE=%.1f dB 过高', upper(mods{i}), mse_list(i));
    end
    pass = true;
    detail = sprintf('QPSK=%.1f 16QAM=%.1f 64QAM=%.1f dB', mse_list(1), mse_list(2), mse_list(3));
end
