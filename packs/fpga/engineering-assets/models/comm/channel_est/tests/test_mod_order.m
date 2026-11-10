function [pass, detail] = test_mod_order()
    rng(0);  % 固定种子保证可复现
% 测试5: 调制阶数 — QPSK/16QAM/64QAM 下长训练符号 LS 一致可用 (ADR-002 基础)
% 估计基础用 LTS, 与数据调制无关; 本测试验证整帧链路在三种调制下估计质量一致。
    cfg.N = 64; cfg.N_cp = 16; cfg.fs = 20e6;
    cfg.N_data = 48; cfg.N_pilot = 4;
    cfg.data_idx  = [-26:-22, -20:-8, -6:-1, 1:6, 8:20, 22:26] + 33;
    cfg.pilot_idx = [-21, -7, 7, 21] + 33;
    cfg.channel_type = 'rayleigh'; cfg.snr_db = 25; cfg.nsym = 4;
    cfg.delay_profiles = [0, 0.2, 0.5, 0.8] * 1e-6;
    cfg.path_gains     = [0, -3, -6, -10];

    mods  = {'QPSK', '16QAM', '64QAM'};
    mod_M = [4, 16, 64];
    mse_list = zeros(length(mods), 1);
    mask = [cfg.data_idx, cfg.pilot_idx];

    for i = 1:length(mods)
        cfg.M = mod_M(i);
        fr = sim_frame(cfg);
        H_est = lts_channel_est(fr.Y_lts, cfg.N);
        mse_list(i) = 10*log10(mean(abs(H_est(mask) - fr.H(mask)).^2));
        assert(mse_list(i) < -10, '%s MSE=%.1f dB 过高 (门限 -10)', mods{i}, mse_list(i));
    end

    pass = true;
    detail = sprintf('QPSK=%.1f 16QAM=%.1f 64QAM=%.1f dB', ...
        mse_list(1), mse_list(2), mse_list(3));
end
