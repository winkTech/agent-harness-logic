function [decoded_bits, num_iter] = ldpc_decoder_bp(llr, H, max_iter)
% <LDPC> 置信传播 (BP/SPA) 译码器
% 使用 MATLAB ldpcDecode (Sum-Product Algorithm)
%
% 输入:
%   llr      - 信道 LLR [N×1]
%   H        - 校验矩阵 (稀疏)
%   max_iter - 最大迭代次数
% 输出:
%   decoded_bits - 译码硬判决 [K×1]
%   num_iter     - 实际迭代次数

    decoder_cfg = ldpcDecoderConfig(H, 'bp');
    [decoded_bits, num_iter] = ldpcDecode(llr, decoder_cfg, max_iter);
end
