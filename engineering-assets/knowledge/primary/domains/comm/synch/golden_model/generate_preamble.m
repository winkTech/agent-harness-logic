function [short_preamble, long_preamble, preamble] = generate_preamble(cfg)
%GENERATE_PREAMBLE  生成 802.11a 前导码 (短 + 长)
%
% 输入:
%   cfg            - 配置结构体 (N, N_short, N_repeat, N_gi2)
% 输出:
%   short_preamble - 短前导码时域 (160x1)
%   long_preamble  - 长前导码时域 (160x1)
%   preamble       - 完整前导码 (320x1)
%
% 参考: IEEE 802.11a-1999, Section 17.3.3

    N = cfg.N;

    %% 短前导码 (Short Preamble)
    % 频域: 12 个非零子载波，间隔 4，位置 [-24:4:-4, 4:4:24]
    short_freq = zeros(N, 1);

    % 802.11a 短前导码频域序列 S_{-26:26} (53 elements)
    S = [0, 0, 1+1j, 0, 0, 0, -1-1j, 0, 0, 0, 1+1j, 0, 0, 0, ...
         -1-1j, 0, 0, 0, -1-1j, 0, 0, 0, 1+1j, 0, 0, 0, ...
          0, 0, 0, 0, -1-1j, 0, 0, 0, -1-1j, 0, 0, 0, ...
          1+1j, 0, 0, 0, 1+1j, 0, 0, 0, 1+1j, 0, 0, 0, ...
          1+1j, 0, 0];

    % 归一化因子 sqrt(13/6)
    S = sqrt(13/6) * S;

    % 放置到子载波 -26..26 (对应 FFT 索引 [39:64, 1, 2:27], 共 53 个)
    sc_idx_53 = [39:N, 1, 2:27];
    short_freq(sc_idx_53) = S(:);

    % IFFT → 时域短符号 (16 样点周期)
    short_symbol = ifft(fftshift(short_freq));

    % 取一个周期 (N_short = 16 样点)
    short_period = short_symbol(1:cfg.N_short);

    % 复制 N_repeat = 10 次
    short_preamble = zeros(cfg.short_len, 1);
    for k = 1:cfg.N_repeat
        idx_start = (k-1) * cfg.N_short + 1;
        idx_end   = k * cfg.N_short;
        short_preamble(idx_start:idx_end) = short_period;
    end

    %% 长前导码 (Long Preamble)
    % 频域: 53 个非零子载波 (含 DC=0)
    long_freq = zeros(N, 1);

    % 802.11a 长前导码频域序列 L_{-26:26} (53 elements)
    L = [1, -1, -1, 1, 1, -1, 1, -1, 1, -1, -1, -1, -1, -1, ...
         1, 1, -1, -1, 1, -1, 1, -1, 1, 1, 1, 1, 0, ...
         1, -1, -1, 1, 1, -1, 1, -1, 1, -1, -1, -1, -1, -1, ...
         1, 1, -1, -1, 1, -1, 1, -1, 1, 1, 1, 1];

    long_freq(sc_idx_53) = L(:);

    % IFFT
    long_symbol = ifft(fftshift(long_freq));

    % GI2 (N_gi2 = 32 样点) + T1 (N = 64) + T2 (N = 64)
    long_gi = long_symbol(end - cfg.N_gi2 + 1 : end);
    long_preamble = [long_gi; long_symbol; long_symbol];

    %% 完整前导码
    preamble = [short_preamble; long_preamble];

end
