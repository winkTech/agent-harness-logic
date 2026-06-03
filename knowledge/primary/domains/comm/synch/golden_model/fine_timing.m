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
    search_window = 64;

    % 长前导码起始 = 短前导码 160 样点 + GI2 32 样点
    n_start = max(1, n_coarse + 160 - 16);
    n_end = min(length(r) - N + 1, n_start + search_window);

    R_max = 0;
    n_opt = n_coarse + 160;

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
