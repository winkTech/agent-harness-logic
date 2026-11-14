function time_sym = ifft_chain(freq_grid, cfg)
%IFFT_CHAIN  OFDM IFFT transform stage
%
%   time_sym = ifft_chain(freq_grid, cfg)
%   将频域 OFDM 符号通过 IFFT 转换为时域采样
%
%   IFFT 输入顺序约定:
%   freq_grid 必须是 MATLAB 自然 IFFT 输入顺序:
%     [DC(位置1), 正子载波(+1..+N/2-1), Nyquist(位置N/2+1), 负子载波(-N/2+1..-1)]
%   这是 subcarrier_map.m 的输出格式, 无需 fftshift/ifftshift
%
%   输入:
%     freq_grid - 频域网格 [N x N_sym], 自然 IFFT 顺序
%     cfg       - 配置结构体 (含 cfg.N)
%   输出:
%     time_sym  - 时域采样 [N x N_sym]
%
%   修复记录 (2026-06-03): 移除了错误的 fftshift 调用。
%   fftshift 交换前后半部分, 将 DC 从位置 1 移到位置 N/2+1,
%   导致频谱搬移 N/2=32 子载波, 接收端从错误的子载波位置解调。

    N = cfg.N;
    N_rows = size(freq_grid, 1);
    if N_rows ~= N
        error('ifft_chain:dimMismatch', ...
              'freq_grid has %d rows but cfg.N = %d', N_rows, N);
    end

    N_sym = size(freq_grid, 2);
    time_sym = zeros(N, N_sym);

    for sym_idx = 1:N_sym
        % freq_grid(:, sym_idx) 已是自然 IFFT 输入顺序 [DC, 正, Nyquist, 负]
        % MATLAB ifft() 期望此顺序, 无需 fftshift/ifftshift
        % sqrt(N) 缩放保持 Parseval 功率一致性
        time_sym(:, sym_idx) = ifft(freq_grid(:, sym_idx), N) * sqrt(N);
    end
end
