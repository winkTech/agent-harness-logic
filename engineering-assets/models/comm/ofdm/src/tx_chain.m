function [tx_signal, tx_info] = tx_chain(cfg)
%% OFDM 发射机链路
%  输入: cfg - 配置结构体
%  输出: tx_signal - 时域发射信号 [N_sym*(N+N_cp) x 1]
%         tx_info   - 发射信息结构体 (用于调试和比对)

    fprintf('=== OFDM 发射机 ===\n');
    fprintf('调制方式: %s, FFT点数: %d, CP长度: %d\n', ...
        cfg.mod_type, cfg.N, cfg.N_cp);
    fprintf('符号数: %d, 数据子载波: %d\n', cfg.N_sym, cfg.N_data);

    %% === 1. 数据生成 ===
    N_bits = cfg.N_sym * cfg.N_data * cfg.mod_order;
    tx_bits = randi([0 1], N_bits, 1);
    tx_info.tx_bits = tx_bits;
    fprintf('  数据比特: %d\n', N_bits);

    %% === 2. 调制映射 ===
    mod_sym = mod_mapper(tx_bits, cfg.mod_type);
    tx_info.mod_sym = mod_sym;  % [N_data x N_sym]
    fprintf('  调制符号: %d x %d\n', size(mod_sym,1), size(mod_sym,2));

    %% === 3. 子载波映射 (数据+导频+DC+保护带) ===
    freq_grid = subcarrier_map(mod_sym, cfg);
    tx_info.freq_grid = freq_grid;  % [N x N_sym]
    fprintf('  频域网格: %d x %d\n', size(freq_grid,1), size(freq_grid,2));

    %% === 4. IFFT ===
    time_sym = ifft_chain(freq_grid, cfg);
    tx_info.time_sym = time_sym;  % [N x N_sym]
    fprintf('  IFFT输出: %d x %d\n', size(time_sym,1), size(time_sym,2));

    %% === 5. 加循环前缀 ===
    cp_sym = add_cp(time_sym, cfg.N_cp);
    tx_info.cp_sym = cp_sym;  % [(N+N_cp) x N_sym]

    %% === 6. 串行化输出 ===
    tx_signal = cp_sym(:);
    tx_info.tx_signal = tx_signal;

    fprintf('  时域输出: %d samples\n', length(tx_signal));
    fprintf('=== 发射完成 ===\n');
end
