function [ber, iter_avg] = sim_ldpc_ber(snr_db, cfg, H)
% <LDPC> 在指定 SNR 下仿真 BER (纯 MATLAB 参考模型)
%
% 使用自实现的 802.11n 编码器 + Min-Sum 译码器
%
% 输入:
%   snr_db - SNR (dB)
%   cfg    - 配置结构体
%   H      - 校验矩阵
% 输出:
%   ber      - 误比特率
%   iter_avg - 平均迭代次数

    num_blocks = max(1, floor(cfg.num_bits / cfg.K));
    total_bits = num_blocks * cfg.K;
    bit_errors = 0;
    total_iter = 0;

    snr_lin = 10^(snr_db / 10);
    noise_var = 1 / (2 * cfg.R * snr_lin);

    for blk = 1:num_blocks
        info = randi([0 1], cfg.K, 1);
        code = ldpc_encode_80211n(info, H, cfg);
        tx = 1 - 2 * double(code);
        rx = tx + sqrt(noise_var) * randn(cfg.N, 1);
        llr = 2 * rx / noise_var;

        [dec_bits, iter] = ldpc_decoder_ms_pure(llr, H, cfg.max_iter, cfg.scale_factor);

        bit_errors = bit_errors + sum(dec_bits ~= info);
        total_iter = total_iter + iter;
    end

    ber = bit_errors / total_bits;
    iter_avg = total_iter / num_blocks;
end
