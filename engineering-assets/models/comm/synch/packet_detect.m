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
    % 上界必须留出相关窗长度: 窗内要访问 r(n+k), k 最大 L-1, 故 n 最大为
    % N_sig-L+1。原来写成 N_sig, 一进循环就越界 (Index exceeds ...),
    % 整个 golden 主仿真跑不到底 —— 这是 synch 向量目录长期为空的第二个原因。
    for n = L+N_short+1:N_sig-L+1
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
    %
    % algorithm_spec §2.1 的判据是 "M[n] > eta 持续 >= 8 个样点"。
    % 原实现取 find(M_smooth>eta, 1, 'first') 作为平顶起点, 再要求其后 9 点
    % 全部越限 —— 只要平顶之前出现**一个**噪声尖峰, 起点就被钉在尖峰上,
    % 紧接着的判断必然失败, 整次检测报 false。实测检测率因此只有 85%。
    % 正确读法是"存在一段长度 >= 9 的连续越限区间", 而不是"第一个越限点
    % 之后必须连续越限"。
    P_RUN   = 9;
    above   = M_smooth > eta;
    plateau = [];
    run_c   = 0;
    for n = 1:N_sig
        if above(n)
            run_c = run_c + 1;
            if run_c >= P_RUN
                plateau = n - P_RUN + 1;
                break;
            end
        else
            run_c = 0;
        end
    end

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
