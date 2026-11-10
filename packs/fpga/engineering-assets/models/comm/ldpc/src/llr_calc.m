function llr = llr_calc(y, noise_var, mod_order)
% <LDPC> 计算对数似然比 (LLR)
% 输入:
%   y          - 接收符号 [N×1]
%   noise_var  - 噪声方差
%   mod_order  - 调制阶数 (1=DBPSK, 2=BPSK)
% 输出:
%   llr        - LLR 值 [N×1]

    switch mod_order
        case {1, 2}  % BPSK: s = 1 - 2c
            % L(c) = 2y / σ²
            llr = 2 * y / noise_var;
        otherwise
            error('未实现的调制阶数: %d', mod_order);
    end
end
