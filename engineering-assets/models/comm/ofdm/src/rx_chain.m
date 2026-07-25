function [rx_bits, rx_info] = rx_chain(rx_signal, cfg)
%% OFDM 接收机链路
%  输入: rx_signal - 时域接收信号
%         cfg       - 配置
%  输出: rx_bits   - 解调比特
%         rx_info   - 接收信息结构体

    N = cfg.N;
    N_cp = cfg.N_cp;
    sym_len = N + N_cp;

    %% 1. 去CP + 串行转并行
    N_sym = floor(length(rx_signal) / sym_len);
    time_sym = zeros(N, N_sym);
    for sym_idx = 1:N_sym
        start_idx = (sym_idx-1) * sym_len + N_cp + 1;
        time_sym(:, sym_idx) = rx_signal(start_idx : start_idx+N-1);
    end
    rx_info.time_sym = time_sym;

    %% 2. FFT
    freq_sym = zeros(N, N_sym);
    for sym_idx = 1:N_sym
        freq_sym(:, sym_idx) = fft(time_sym(:, sym_idx)) / sqrt(N);
    end
    rx_info.freq_sym = freq_sym;

    %% 3. 子载波解映射 (提取数据子载波)
    data_sym = zeros(cfg.N_data, N_sym);
    for sym_idx = 1:N_sym
        for d = 1:cfg.N_data
            bin = subcarrier_idx_to_bin(cfg.data_idx(d), N);
            data_sym(d, sym_idx) = freq_sym(bin+1, sym_idx);
        end
    end
    rx_info.data_sym = data_sym;

    %% 4. 解调
    rx_bits = mod_demapper(data_sym(:), cfg.mod_type);
end

function bin = subcarrier_idx_to_bin(idx, N)
    if idx < 0
        bin = N + idx;
    else
        bin = idx;
    end
end
