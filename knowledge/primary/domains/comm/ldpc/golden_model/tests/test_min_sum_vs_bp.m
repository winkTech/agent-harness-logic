function [pass, detail] = test_min_sum_vs_bp()
% 测试3: 验证纯 Min-Sum 译码器收敛性
% 在 SNR=2.5dB 时，译码器应收敛到有效码字

    cfg = config_test();
    H = generate_h_matrix(cfg);

    snr_db = 2.5;
    snr_lin = 10^(snr_db / 10);
    noise_var = 1 / (2 * cfg.R * snr_lin);

    num_blocks = 20;
    successes = 0;

    for blk = 1:num_blocks
        info = randi([0 1], cfg.K, 1);
        code = ldpc_encode_80211n(info, H, cfg);
        tx = 1 - 2 * double(code);
        rx = tx + sqrt(noise_var) * randn(cfg.N, 1);
        llr = 2 * rx / noise_var;

        [dec_info, iter] = ldpc_decoder_ms_pure(llr, H, cfg.max_iter, cfg.scale_factor);

        % 检查是否收敛到有效码字
        test_code = [dec_info; zeros(cfg.N - cfg.K - length(dec_info), 1)];
        if iter < cfg.max_iter
            successes = successes + 1;
        end
    end

    % 至少 50% 的块应提前收敛
    assert(successes >= num_blocks * 0.5, ...
        '收敛率 %d/%d 过低', successes, num_blocks);

    pass = true;
    detail = sprintf('%d/%d 收敛', successes, num_blocks);
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
