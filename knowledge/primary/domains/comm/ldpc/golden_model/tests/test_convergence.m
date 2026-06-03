function [pass, detail] = test_convergence()
% 测试4: 高 SNR 收敛性验证
% SNR=4dB 时多数码块应提前收敛 (iter < max_iter)

    cfg = config_test();
    H = generate_h_matrix(cfg);

    snr_db = 4;
    snr_lin = 10^(snr_db / 10);
    noise_var = 1 / (2 * cfg.R * snr_lin);

    num_blocks = 20;
    total_iter = 0;

    for blk = 1:num_blocks
        info = randi([0 1], cfg.K, 1);
        code = ldpc_encode_80211n(info, H, cfg);
        tx = 1 - 2 * double(code);
        rx = tx + sqrt(noise_var) * randn(cfg.N, 1);
        llr = 2 * rx / noise_var;

        [~, iter] = ldpc_decoder_ms_pure(llr, H, cfg.max_iter, cfg.scale_factor);
        total_iter = total_iter + iter;
    end

    avg_iter = total_iter / num_blocks;
    assert(avg_iter < cfg.max_iter * 0.8, ...
        '平均迭代 %.1f 过高 (max=%d)', avg_iter, cfg.max_iter);

    pass = true;
    detail = sprintf('avg_iter=%.1f (max=%d)', avg_iter, cfg.max_iter);
end

function cfg = config_test()
    cfg.N = 648; cfg.K = 324; cfg.R = 1/2; cfg.Z = 27;
    cfg.mb = 12; cfg.nb = 24; cfg.M = 324;
    cfg.P = [ ...
         0, -1, -1, -1,  0,  0, -1, -1,  0, -1, -1,  0,  1,  0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1; ...
        22,  0, -1, -1, 17, -1,  0,  0, 12, -1, -1, -1, -1,  0,  0, -1, -1, -1, -1, -1, -1, -1, -1, -1; ...
         6, -1,  0, -1, 10, -1, -1, -1, 24, -1,  0, -1, -1, -1,  0,  0, -1, -1, -1, -1, -1, -1, -1, -1; ...
         2, -1, -1,  0, 20, -1, -1, -1, 25,  0, -1, -1, -1, -1, -1,  0,  0, -1, -1, -1, -1, -1, -1, -1; ...
        23, -1, -1, -1,  3, -1, -1, -1,  0, -1,  9, 11, -1, -1, -1, -1,  0,  0, -1, -1, -1, -1, -1, -1; ...
        24, -1, 23,  1, 17, -1,  3, -1, 10, -1, -1, -1, -1, -1, -1, -1, -1,  0,  0, -1, -1, -1, -1, -1; ...
        25, -1, -1, -1,  8, -1, -1, -1,  7, 18, -1, -1,  0, -1, -1, -1, -1, -1,  0,  0, -1, -1, -1, -1; ...
        13, 24, -1, -1,  0, -1,  8, -1,  6, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,  0,  0, -1, -1, -1; ...
         7, 20, -1, 16, 22, 10, -1, -1, 23, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,  0,  0, -1, -1; ...
        11, -1, -1, -1, 19, -1, -1, -1, 13, -1,  3, 17, -1, -1, -1, -1, -1, -1, -1, -1, -1,  0,  0, -1; ...
        25, -1,  8, -1, 23, 18, -1, 14,  9, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,  0,  0; ...
         3, -1, -1, -1, 16, -1, -1,  2, 25,  5, -1, -1,  1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,  0];
    cfg.max_iter = 50;
    cfg.scale_factor = 0.75;
    cfg.mod_order = 2;
end
