function freq_grid = subcarrier_map(mod_sym, cfg)
%% 子载波映射: 数据+导频+DC+保护带
%  输入: mod_sym - 调制符号 [N_data x N_sym]
%        cfg     - 配置结构体
%  输出: freq_grid - 频域网格 [N x N_sym]

    N_sym = size(mod_sym, 2);
    freq_grid = zeros(cfg.N, N_sym);

    for sym_idx = 1:N_sym
        % 1. 放置导频 (Pilot)
        % 802.11a 导频极性随符号变化
        pilot_polarity = 1;
        if mod(sym_idx-1, 2) == 1
            pilot_polarity = -1;
        end
        for p = 1:cfg.N_pilot
            % 将导频索引(-21,-7,7,21)映射到FFT bin (0-based)
            bin = pilot_idx_to_bin(cfg.pilot_idx(p), cfg.N);
            freq_grid(bin+1, sym_idx) = pilot_polarity * cfg.pilot_val(p);
        end

        % 2. 放置数据
        for d = 1:cfg.N_data
            bin = pilot_idx_to_bin(cfg.data_idx(d), cfg.N);
            freq_grid(bin+1, sym_idx) = mod_sym(d, sym_idx);
        end

        % 3. DC和Guard已经是0 (初始化时)
    end
end

function bin = pilot_idx_to_bin(idx, N)
% 将子载波索引(-N/2 ~ N/2-1)映射到FFT bin (0 ~ N-1)
    if idx < 0
        bin = N + idx;
    else
        bin = idx;
    end
end
