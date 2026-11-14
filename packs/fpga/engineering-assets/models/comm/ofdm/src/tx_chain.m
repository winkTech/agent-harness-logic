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
    % 修复 (2026-08-01, ADR-004 G1 关联): 阶数从 mod_type 单一事实源推导 —
    % 原用 cfg.mod_order (默认 2), 测试只改 mod_type 时 BPSK/16QAM/64QAM
    % 比特数全部错位 (BPSK 960 比特映出 960 符号 != 48x10)。
    switch cfg.mod_type
        case 'BPSK',  mod_order = 1;
        case 'QPSK',  mod_order = 2;
        case '16QAM', mod_order = 4;
        case '64QAM', mod_order = 6;
        otherwise, error('tx_chain: 不支持的调制方式: %s', cfg.mod_type);
    end
    N_bits = cfg.N_sym * cfg.N_data * mod_order;
    tx_bits = randi([0 1], N_bits, 1);
    tx_info.tx_bits = tx_bits;
    fprintf('  数据比特: %d\n', N_bits);

    %% === 2. 调制映射 ===
    % 修复 (2026-08-01, ADR-004 G1): mod_mapper 返回列向量 [N_data·N_sym×1],
    % 而 subcarrier_map 按 [N_data×N_sym] 消费 (size(...,2) 当符号数) ——
    % 原先整帧只产出 1 个符号 (80 样点而非 800), run_all_tests 0/3 的根因。
    mod_sym = reshape(mod_mapper(tx_bits, cfg.mod_type), cfg.N_data, cfg.N_sym);
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
