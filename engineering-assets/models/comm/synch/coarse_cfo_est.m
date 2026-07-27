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

    % 相关窗必须整体落在短前导码内 —— 那里才有 N_short 样点周期性。
    %
    % 原式 n0 = n_start + 32; n_vals = n0:16:n0+80; 只向后取, 且每个窗还要
    % 访问到 n+N_short+L-1。实测 n_start=120 时窗覆盖到 263, 而短前导码
    % (tau=50, short_len=160) 只到 209 —— 后几个窗落进长前导码, 那里没有
    % 16 样点周期, 直接给 angle(C) 引入偏置。
    %
    % packet_detect 返回的是判决平顶的中点, 因此以 n_start 为中心向两侧取,
    % 半宽 W 由配置推出: 短前导码半长减去一个窗自身要占的长度。
    if isfield(cfg, 'short_len'), short_len = cfg.short_len; else, short_len = N_short * 10; end
    W = floor(short_len/2) - (N_short + L);          % 可用半宽
    n_lo = max(1, n_start - W);
    n_hi = n_start + W - (N_short + L - 1);
    n_vals = n_lo:N_short:n_hi;

    C_sum = 0;
    count = 0;

    for n = n_vals
        if n + N_short + L - 1 <= length(r)
            C = 0;
            for k = 0:L-1
                % 必须是 后一周期 × conj(前一周期): r[m+N_short]·conj(r[m])
                % 才有 angle(C) = +2*pi*eps*N_short/N, 与 L33 的反解式同号。
                % 原式写成 r(n+k)*conj(r(n+k+N_short)), 是它的共轭 ->
                % 估计值符号翻转 (实测 实际 0.3000 估成 -0.3973)。
                % packet_detect.m:23 用的是正确约定 (r[m]·conj(r[m-N_short])),
                % 两处约定相反, 本函数是不一致的那个。
                C = C + r(n+k+N_short) * conj(r(n+k));
            end
            C_sum = C_sum + C;
            count = count + 1;
        end
    end

    C_avg = C_sum / max(count, 1);
    epsilon_est = (N / (2 * pi * N_short)) * angle(C_avg);

end
