function [decoded_bits, num_iter] = ldpc_decoder_ms(llr, H, max_iter, scale_factor)
% <LDPC> 最小和 (Min-Sum) 译码器 (硬件友好)
%
% 使用偏移最小和算法 (Offset Min-Sum):
%   校验节点更新: L_j→i = α · Π(sign) · min(|msg|)
%   α = 缩放因子 (0.75 ~ 0.875)
%
% 输入:
%   llr          - 信道 LLR [N×1]
%   H            - 校验矩阵 (稀疏)
%   max_iter     - 最大迭代次数
%   scale_factor - 缩放因子 α (默认 0.75)
% 输出:
%   decoded_bits - 译码硬判决 [K×1]
%   num_iter     - 实际迭代次数

    if nargin < 4
        scale_factor = 0.75;
    end

    decoder_cfg = ldpcDecoderConfig(H, 'minsum', scale_factor);
    [decoded_bits, num_iter] = ldpcDecode(llr, decoder_cfg, max_iter);
end
