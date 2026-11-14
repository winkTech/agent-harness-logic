function [pass, detail] = test_snr_range()
% 测试4: SNR 范围 — 长训练符号 LS 的 MSE 随 SNR 单调下降 (ADR-002 基础)
% 每个 SNR 点重置种子 → 同一信道实现与同一归一化噪声样本, 仅噪声幅度随
% SNR 缩放, MSE 单调性有确定性保证。
    cfg.N = 64; cfg.N_cp = 16; cfg.fs = 20e6;
    cfg.N_data = 48; cfg.N_pilot = 4; cfg.M = 16;
    cfg.data_idx  = [-26:-22, -20:-8, -6:-1, 1:6, 8:20, 22:26] + 33;
    cfg.pilot_idx = [-21, -7, 7, 21] + 33;
    cfg.channel_type = 'rayleigh'; cfg.nsym = 1;
    cfg.delay_profiles = [0, 0.2, 0.5, 0.8] * 1e-6;
    cfg.path_gains     = [0, -3, -6, -10];

    snr_list = 0:5:30;
    mse_list = zeros(size(snr_list));
    mask = [cfg.data_idx, cfg.pilot_idx];

    for i = 1:length(snr_list)
        rng(0);
        cfg.snr_db = snr_list(i);
        fr = sim_frame(cfg);
        H_est = lts_channel_est(fr.Y_lts, cfg.N);
        mse_list(i) = 10*log10(mean(abs(H_est(mask) - fr.H(mask)).^2));
    end

    assert(all(diff(mse_list) < 0), 'MSE 不单调: %s', mat2str(mse_list, 3));
    assert(mse_list(end) < -25, 'SNR=30dB MSE=%.1f dB 过高', mse_list(end));
    pass = true;
    detail = sprintf('SNR→MSE: [%s] dB', ...
        strjoin(arrayfun(@(x)sprintf('%.1f', x), mse_list, 'un', 0), ' '));
end
