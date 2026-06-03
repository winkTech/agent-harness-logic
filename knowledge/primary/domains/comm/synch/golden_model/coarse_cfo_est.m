function [epsilon_est, C_avg] = coarse_cfo_est(r, n_start, cfg)
% <同步> 粗 CFO 估计 — 利用短前导码周期自相关
% 输入:
%   r       - 接收信号
%   n_start - 粗定时起始 (短前导码区域)
%   cfg     - 配置 (N_short, L_corr)
% 输出:
%   epsilon_est - 归一化 CFO 估计值
%   C_avg       - 平均自相关值 (用于评估)

    N_short = cfg.N_short;
    L       = cfg.L_corr;
    N       = cfg.N;

    n0 = n_start + 32;
    n_vals = n0:16:n0+16*5;

    C_sum = 0;
    count = 0;

    for n = n_vals
        if n + N_short + L - 1 <= length(r)
            C = 0;
            for k = 0:L-1
                C = C + r(n+k) * conj(r(n+k+N_short));
            end
            C_sum = C_sum + C;
            count = count + 1;
        end
    end

    C_avg = C_sum / max(count, 1);
    epsilon_est = (N / (2 * pi * N_short)) * angle(C_avg);

end
