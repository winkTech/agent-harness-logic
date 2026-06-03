function [detected, n_peak, M] = packet_detect(r, cfg)
% <同步> 包检测 — 基于短前导码周期自相关
% 输入:
%   r      - 接收信号 [N×1]
%   cfg    - 配置结构体 (含 N_short, L_corr, eta_detect)
% 输出:
%   detected - 是否检测到包
%   n_peak   - 峰值索引
%   M        - 归一化判决度量序列

    N_short = cfg.N_short;  % 16
    L       = cfg.L_corr;   % 16
    eta     = cfg.eta_detect; % 0.5
    N_sig   = length(r);

    C = zeros(N_sig, 1);  % 自相关
    P = zeros(N_sig, 1);  % 能量
    M = zeros(N_sig, 1);

    % 滑动自相关
    for n = L+N_short+1:N_sig
        for k = 0:L-1
            C(n) = C(n) + r(n+k) * conj(r(n+k-N_short));
            P(n) = P(n) + real(r(n+k-N_short) * conj(r(n+k-N_short)));
        end
    end

    % 归一化判决度量
    P_safe = P + eps;  % 防除零
    M = abs(C).^2 ./ (abs(P_safe).^2);

    % 峰值检测
    M_smooth = movmean(M, 5);  % 平滑
    plateau = find(M_smooth > eta, 1, 'first');

    if ~isempty(plateau) && plateau + 8 < N_sig
        if all(M_smooth(plateau:plateau+8) > eta)
            detected = true;
            % 取平顶中点作为粗定时位置
            plateau_end = find(M_smooth(plateau:end) < eta, 1, 'first');
            if isempty(plateau_end)
                n_peak = plateau + 8;
            else
                n_peak = plateau + floor(plateau_end/2);
            end
        else
            detected = false;
            n_peak = [];
        end
    else
        detected = false;
        n_peak = [];
    end

end
