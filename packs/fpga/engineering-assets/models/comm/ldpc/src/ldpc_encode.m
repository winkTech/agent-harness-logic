function [code, encoder_cfg] = ldpc_encode(info_bits, H)
% <LDPC> 编码函数 (使用 MATLAB ldpcEncode)
% 输入:
%   info_bits - 信息位 [K×1] (逻辑/二进制)
%   H         - 校验矩阵 (稀疏)
% 输出:
%   code        - 编码码字 [N×1] (逻辑)
%   encoder_cfg - 编码器配置 (供译码使用)

    encoder_cfg = ldpcEncoderConfig(H);
    code = ldpcEncode(info_bits, encoder_cfg);
end
