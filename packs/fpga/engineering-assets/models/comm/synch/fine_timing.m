function [n_opt, R_peak] = fine_timing(r, n_coarse, t_long, cfg)
% <同步> 精定时 — 长前导码滑动互相关
% 输入:
%   r        - 接收信号 (CFO 补偿后)
%   n_coarse - 粗定时位置 (短前导码检测)
%   t_long   - 长前导码 T1 时域序列 (64x1)
%   cfg      - 配置
% 输出:
%   n_opt    - 精定时位置 (FFT 窗口起始)
%   R_peak   - 峰值互相关值

    N = cfg.N;
    if isfield(cfg, 'short_len'), short_len = cfg.short_len; else, short_len = 160; end
    if isfield(cfg, 'N_gi2'),     n_gi2     = cfg.N_gi2;     else, n_gi2     = 32;  end

    % 搜索窗必须覆盖 T1 的真实位置。
    %
    % 原式 n_start = n_coarse + 160 - 16, n_end = n_start + 64, 隐含假设
    % n_coarse 就是**包起点**。但 packet_detect 返回的是判决平顶的**中点**
    % (它自己的注释写着"取平顶中点作为粗定时位置"), 两者相差约半个短前导码。
    % 实测: n_coarse=120 -> 搜索 [264,328], 而 T1 真实起点 tau+192=242
    % 根本不在窗内, 于是返回窗内次优点 307, 误差恰好 65 样点。
    %
    % 这里不去猜 n_coarse 的语义, 改为给出一个必然包含 T1 的下界与上界:
    % T1 一定在粗定时点之后, 且不会超过 (短前导码 + GI2 + 一个长符号)。
    % 互相关对 T1 是尖峰, 窗放宽不会引入误判, 只多花些运算。
    n_start = max(1, n_coarse);
    n_end   = min(length(r) - N + 1, n_coarse + short_len + n_gi2 + N);

    R_max  = 0;
    n_opt  = n_coarse + short_len + n_gi2;   % 兜底值 = 名义位置
    R_peak = 0;

    for n = n_start:n_end
        R = 0;
        for k = 0:N-1
            R = R + r(n+k) * conj(t_long(k+1));
        end
        R_abs = abs(R)^2;
        if R_abs > R_max
            R_max = R_abs;
            n_opt = n;
            R_peak = R;
        end
    end

end
