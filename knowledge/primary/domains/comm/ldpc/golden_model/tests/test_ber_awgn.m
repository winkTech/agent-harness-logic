function [pass, detail] = test_ber_awgn()
% 测试2: AWGN BER — 编码增益验证
% 在 SNR=3dB 时 BER < 1e-2 (纯 MATLAB 参考模型)

    cfg = config_test();
    H = generate_h_matrix(cfg);

    snr_db = 3;
    snr_lin = 10^(snr_db / 10);
    noise_var = 1 / (2 * cfg.R * snr_lin);

    num_blocks = 20;  % 6480 bit
    total_bits = num_blocks * cfg.K;
    bit_errors = 0;

    for blk = 1:num_blocks
        info = randi([0 1], cfg.K, 1);
        code = ldpc_encode_80211n(info, H, cfg);
        tx = 1 - 2 * double(code);
        rx = tx + sqrt(noise_var) * randn(cfg.N, 1);
        llr = 2 * rx / noise_var;

        [dec_info, ~] = ldpc_decoder_ms_pure(llr, H, cfg.max_iter, cfg.scale_factor);
        bit_errors = bit_errors + sum(dec_info ~= info);
    end

    ber = bit_errors / total_bits;
    % SNR=3dB 时 BER 应 << uncoded ~0.02
    assert(ber < 1e-2, 'BER=%.2e 过高 (期望 < 1e-2)', ber);

    pass = true;
    detail = sprintf('BER=%.2e @ SNR=%d dB', ber, snr_db);
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
