%% OFDM 发射机完整仿真
%  运行: 发射链路 + 接收链路 + BER测量 + 测试向量导出
% ============================================================================

clear; clc; close all;
addpath('src');
addpath('tests');

%% 1. 加载配置
cfg = config;
fprintf('OFDM 仿真开始\n');
fprintf('========================================\n\n');

%% 2. 发射
[tx_signal, tx_info] = tx_chain(cfg);

%% 3. 信道 (理想信道 - 无噪声, 用于验证)
rx_signal = tx_signal;

%% 4. 接收
[rx_bits, rx_info] = rx_chain(rx_signal, cfg);

%% 5. BER 验证 (理想信道下应为0)
ber = sum(abs(tx_info.tx_bits - rx_bits)) / length(tx_info.tx_bits);
fprintf('\nBER (理想信道): %g\n', ber);

%% 6. EVM 测量
% 比较 IFFT输入频域符号
freq_tx = tx_info.freq_grid(:);
freq_rx = rx_info.freq_sym(:);
evm = measure_evm(freq_tx, freq_rx);
fprintf('EVM (频域): %.2f dB\n', evm);

%% 7. 导出测试向量
if cfg.save_vectors
    generate_vectors(tx_signal, tx_info, cfg);
end

%% 8. 绘图
if cfg.plot_en
    figure('Position', [100 100 1200 800]);

    % 8a. 时域波形 (I/Q)
    subplot(2,2,1);
    t = (0:length(tx_signal)-1) / cfg.fs * 1e6;
    plot(t, real(tx_signal), 'b', t, imag(tx_signal), 'r');
    xlabel('Time (us)'); ylabel('Amplitude');
    title('OFDM 时域波形 (I/Q)');
    legend('I', 'Q'); grid on;

    % 8b. 频谱
    subplot(2,2,2);
    [Pxx, f] = pwelch(tx_signal, [], [], [], cfg.fs);
    plot(f/1e6, 10*log10(Pxx));
    xlabel('Frequency (MHz)'); ylabel('PSD (dB)');
    title('OFDM 频谱'); grid on;

    % 8c. 星座图 (IFFT输入)
    subplot(2,2,3);
    plot(real(tx_info.mod_sym), imag(tx_info.mod_sym), 'b.');
    xlabel('I'); ylabel('Q');
    title(sprintf('星座图 (%s)', cfg.mod_type));
    axis equal; grid on; axis([-2 2 -2 2]);

    % 8d. PAPR
    subplot(2,2,4);
    papr = papr_ccdf(tx_signal, 0.1);
    plot(papr.ccdf_db, papr.ccdf_prob);
    xlabel('PAPR (dB)'); ylabel('CCDF');
    title('PAPR 分布'); grid on;

    saveas(gcf, 'results/ofdm_sim_results.png');
end

fprintf('\n========================================\n');
fprintf('仿真完成\n');

%% ===== 辅助函数 =====

function evm = measure_evm(ref, sig)
% EVM 测量
    err = sig - ref;
    p_ref = mean(abs(ref).^2);
    p_err = mean(abs(err).^2);
    evm = 10*log10(p_err / p_ref);
end

function result = papr_ccdf(signal, threshold)
% PAPR CCDF 计算
    N = length(signal);
    power = abs(signal).^2;
    p_avg = mean(power);
    papr_db = 10*log10(power / p_avg);

    [ccdf_prob, ccdf_db] = ecdf(papr_db);
    result.ccdf_db = ccdf_db;
    result.ccdf_prob = 1 - ccdf_prob;
end
