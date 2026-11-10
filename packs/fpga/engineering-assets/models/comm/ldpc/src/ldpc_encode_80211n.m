function code = ldpc_encode_80211n(info_bits, H, cfg)
% <LDPC> 802.11n QC-LDPC 系统编码器
%
% 编码公式: codeword = [info_bits; parity], 其中 parity = PT * info_bits (GF(2))
% PT 矩阵通过 GF(2) 求解 H_p * PT = H_s 预计算并存储在 PT_1_2_648.mat
%
% 输入:
%   info_bits - 信息位 [K×1]
%   H         - 校验矩阵 (sparse logical/double)，未使用（保留接口兼容）
%   cfg       - 配置 (.K)，未使用（保留接口兼容）
% 输出:
%   code      - 编码码字 [N×1] (logical)，前 K 位 = info_bits

    persistent PT

    K = 324;  % 802.11n R=1/2, N=648

    info_bits = info_bits(:);
    if length(info_bits) ~= K
        error('info_bits 长度必须为 %d', K);
    end

    %% 预计算 PT 矩阵（仅第一次调用）
    if isempty(PT)
        S = load(fullfile(fileparts(mfilename('fullpath')), '..', 'PT_1_2_648.mat'));
        PT = S.PT;
    end

    %% 编码: parity = PT * info (GF(2))
    parity = mod(PT * double(info_bits), 2);
    code = logical([info_bits; parity]);
end
