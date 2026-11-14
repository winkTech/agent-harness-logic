function [dec_bits, num_iter] = ldpc_decoder_ms_pure(llr, H, max_iter, scale_factor)
% <LDPC> 纯 MATLAB Min-Sum 译码器 (硬件参考模型)
%
% 分层 Min-Sum 译码算法 (Layered Min-Sum Decoding)
%   支持任意 H 矩阵 (无需满秩)
%
% 算法:
%   for iter = 1:max_iter
%       for row = 1:M (每行对应一个校验节点)
%           1. 读取 VN 消息: L_q = LLR_total - L_old
%           2. CN 更新: L_r = alpha * prod(sign) * min(|L_q|)
%           3. VN 更新: LLR_total = L_q + L_r
%       end
%       if H * hard_decision == 0, break
%   end
%
% 输入:
%   llr          - 信道 LLR [N×1] (浮点)
%   H            - 校验矩阵 (sparse double/logical, [M×N])
%   max_iter     - 最大迭代次数
%   scale_factor - Min-Sum 缩放因子 alpha (默认 0.75)
% 输出:
%   dec_bits - 译码结果 [K×1]
%   num_iter - 实际迭代次数

    if nargin < 4, scale_factor = 0.75; end

    [M, N] = size(H);
    K = N - M;

    % 预处理: 获取每行的列索引 (CN→VN 连接)
    row_cols = cell(M, 1);
    for row = 1:M
        row_cols{row} = find(H(row, :));
    end

    % 初始化
    LLR_total = llr(:);     % [N×1]
    L_r_old = zeros(M, N);  % 旧 CN→VN 消息

    %% 主迭代循环
    for iter = 1:max_iter
        for row = 1:M
            cols = row_cols{row};
            if isempty(cols), continue; end

            % VN→CN 消息
            L_q = LLR_total(cols) - L_r_old(row, cols).';

            %% CN 更新: Min-Sum
            signs = sign(L_q);
            abs_q = abs(L_q);

            [min1, min1_idx] = min(abs_q);
            if length(cols) > 1
                abs_q2 = abs_q;
                abs_q2(min1_idx) = inf;
                min2 = min(abs_q2);
            else
                min2 = min1;
            end

            prod_sign = prod(signs);

            for j = 1:length(cols)
                col = cols(j);
                if j == min1_idx
                    L_r = min2;
                else
                    L_r = min1;
                end
                L_r = L_r * prod_sign * signs(j) * scale_factor;
                L_r_old(row, col) = L_r;

                % VN 更新 (逐个)
                LLR_total(col) = L_q(j) + L_r;
            end
        end

        %% 硬判决 + 早停
        hard = double(LLR_total < 0);
        if mod(H * hard(:), 2) == 0
            dec_bits = hard(1:K);
            num_iter = iter;
            return;
        end
    end

    hard = double(LLR_total < 0);
    dec_bits = hard(1:K);
    num_iter = max_iter;
end
