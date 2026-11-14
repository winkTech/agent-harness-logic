function [sym_grid, info] = rx_cp_window(rx_stream, fft_start_idx, n_sym, cfg)
%RX_CP_WINDOW  按 802.11a 帧结构切窗 (cp_remove 的正确性锚)
%
%   [sym_grid, info] = rx_cp_window(rx_stream, fft_start_idx, n_sym, cfg)
%
%   为什么不复用 rx_chain: src/rx_chain.m 第 10-17 行按 sym_len = N + N_cp = 80
%   **均匀**切窗, 不建模前导 —— 长前导的 T1/T2 各 64 样点且**不带 CP**, 与数据符号
%   的 CP16+64 结构不同。故 rx_chain 无法作为 cp_remove 的 LTS 切窗正确性锚,
%   本函数补上这一段, 并保持 rx_chain 的既有行为分毫不动。
%
%   帧结构 (取自 models/comm/synch/config.m 与 generate_preamble.m,
%   该 golden 引 IEEE 802.11a-1999 Section 17.3.3):
%     STS      = 10 x 16 = 160
%     GI2      = 32                  <- 由 sync_top 在上游消化, 本函数不见
%     T1 = T2  = 64  (长前导总长 32+64+64 = 160)
%     数据符号 = CP(16) + 64 = 80
%
%   切窗序列 (fft_start_idx 指向 T1 首样点, 与 sync_top 的 o_fft_start 同语义):
%     T1 取 64 -> T2 取 64 -> {跳 16 取 64} x n_sym
%   该序列正好喂出 channel_est_top 期待的 [LTS1, LTS2, 数据符号...]
%   (见 cbb/channel_est_top/rtl/channel_est_top.sv 头注释)。
%
%   输入:
%     rx_stream     - 时域接收样点 [L x 1] 复数
%     fft_start_idx - T1 首样点在 rx_stream 中的 1-based 下标
%     n_sym         - 数据符号数 (对应 RTL 的 i_cfg_n_sym)
%     cfg           - 配置结构体 (用 cfg.N 与 cfg.N_cp)
%   输出:
%     sym_grid - [N x (2 + n_sym)] 切窗结果; 第 1/2 列为 T1/T2, 其后为数据符号
%     info     - .starts  每个输出符号首样点在 rx_stream 中的下标
%                .needed  本次切窗消耗到的最后一个样点下标

    N    = cfg.N;
    N_cp = cfg.N_cp;

    if fft_start_idx < 1
        error('rx_cp_window:badStart', 'fft_start_idx 须 >= 1, 实得 %d', fft_start_idx);
    end
    if n_sym < 0
        error('rx_cp_window:badCount', 'n_sym 须 >= 0, 实得 %d', n_sym);
    end

    n_out  = 2 + n_sym;                       % T1 + T2 + 数据符号
    starts = zeros(1, n_out);

    % 长前导: T1/T2 紧邻且不带 CP
    starts(1) = fft_start_idx;
    starts(2) = fft_start_idx + N;

    % 数据符号: 每个先跳 CP 再取 N
    cursor = fft_start_idx + 2*N;
    for k = 1:n_sym
        starts(2 + k) = cursor + N_cp;
        cursor = cursor + N_cp + N;
    end

    needed = starts(end) + N - 1;
    if needed > numel(rx_stream)
        error('rx_cp_window:tooShort', ...
              '样点不足: 需要到下标 %d, 实得 %d (fft_start=%d, n_sym=%d)', ...
              needed, numel(rx_stream), fft_start_idx, n_sym);
    end

    sym_grid = zeros(N, n_out);
    for k = 1:n_out
        sym_grid(:, k) = rx_stream(starts(k) : starts(k) + N - 1);
    end

    info = struct('starts', starts, 'needed', needed);
end
