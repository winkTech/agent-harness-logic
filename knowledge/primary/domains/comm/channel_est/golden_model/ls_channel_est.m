function [H_est, H_interp] = ls_channel_est(Y, X_pilot, pilot_idx, N, method)
% <信道估计> LS 估计 + 插值
% 输入:
%   Y         - 接收频域信号 [N×1]
%   X_pilot   - 已知导频序列 [N_pilot×1]
%   pilot_idx - 导频子载波索引 [N_pilot×1]
%   N         - FFT 点数
%   method    - 插值方法: 'linear' | 'spline' | 'dft'
% 输出:
%   H_est    - 导频处信道估计 [N_pilot×1]
%   H_interp - 全子载波信道估计 [N×1]

    N_pilot = length(pilot_idx);

    %% LS 估计 (导频位置)
    H_est = Y(pilot_idx) ./ X_pilot;

    %% 插值到全子载波
    switch lower(method)
        case 'linear'
            H_interp = interp_linear(H_est, pilot_idx, N);
        case 'spline'
            H_interp = interp_spline(H_est, pilot_idx, N);
        case 'dft'
            H_interp = interp_dft(H_est, pilot_idx, N);
        otherwise
            error('Unknown interpolation method: %s', method);
    end

    %% 处理 DC 和保护子载波 (置 1 或保持)
    % DC: 索引 N/2+1
    dc_idx = N/2 + 1;
    H_interp(dc_idx) = 1;

    % 保护子载波: 置 1 (不携带数据)
    guard = [1:5, N-4:N];
    H_interp(guard) = 1;
end

%% ===== 插值方法 =====

function H = interp_linear(H_pilot, pilot_idx, N)
    % 线性插值 (频域)
    N_pilot = length(H_pilot);
    H = ones(N, 1);

    for k = 2:N_pilot
        idx_start = pilot_idx(k-1);
        idx_end   = pilot_idx(k);
        if idx_end > idx_start
            step = (H_pilot(k) - H_pilot(k-1)) / (idx_end - idx_start);
            for n = idx_start:idx_end
                H(n) = H_pilot(k-1) + step * (n - idx_start);
            end
        end
    end

    % 边缘处理 (首尾导频之外区域)
    for n = 1:pilot_idx(1)-1
        H(n) = H_pilot(1);
    end
    for n = pilot_idx(end)+1:N
        H(n) = H_pilot(end);
    end
end

function H = interp_spline(H_pilot, pilot_idx, N)
    % 三次样条插值
    all_idx = (1:N)';
    H = interp1(pilot_idx, H_pilot, all_idx, 'spline', 'extrap');
end

function H = interp_dft(H_pilot, pilot_idx, N)
    % DFT 插值: 导频 → 时域加窗 → 频域补零 → FFT
    % 将导频视为频域稀疏采样，变换到时域加窗去噪再变换回频域

    N_pilot = length(H_pilot);

    % 导频 → 时域 (IDFT)
    h = ifft(H_pilot, N_pilot);

    % 加窗: 保留前 L 个抽头 (L = 时延扩展对应的样点数)
    L = min(8, N_pilot);  % 假设最大时延 < 8 个样点
    h(L+1:end) = 0;

    % 时域 → 全频域 (DFT)
    h_full = zeros(N, 1);
    h_full(1:L) = h(1:L);
    H = fft(h_full, N);

    % 幅度归一化
    H = H / sqrt(N/N_pilot);
end
