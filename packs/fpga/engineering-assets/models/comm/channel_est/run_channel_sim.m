%% ===========================================================================
%  信道估计 — 主仿真
%  功能: 比较 LS / MMSE / DFT 插值性能
% ============================================================================
clear; clc; close all;
addpath(fileparts(mfilename('fullpath')));

%% 配置
cfg.N          = 64;
cfg.N_data     = 48;
cfg.N_pilot    = 4;
cfg.data_idx   = [-26:-22, -20:-8, -6:-1, 1:6, 8:20, 22:26] + 33;
cfg.pilot_idx  = [-21, -7, 7, 21] + 33;
cfg.M          = 16;             % 16QAM
cfg.channel_type = 'rayleigh';
cfg.delay_profiles = [0, 0.2, 0.5, 0.8] * 1e-6;
cfg.path_gains     = [0, -3, -6, -10];
cfg.snr_db     = 20;
cfg.plot_en    = true;
cfg.save_vectors = false;
cfg.fs         = 20e6;

fprintf('========================================\n');
fprintf('  OFDM 信道估计仿真\n');
fprintf('  信道: %s, SNR=%d dB\n', cfg.channel_type, cfg.snr_db);
fprintf('  导频: %d @ %s\n', cfg.N_pilot, mat2str(cfg.pilot_idx));
fprintf('========================================\n\n');

%% 1. 生成信道数据
[H_true, Y, X, noise] = sim_channel(cfg);

%% 2. 信道估计
pilot_val = X(cfg.pilot_idx);

% LS + 线性插值
fprintf('--- LS + 线性插值 ---\n');
[H_ls_lin, H_full_lin] = ls_channel_est(Y, pilot_val, cfg.pilot_idx, cfg.N, 'linear');

% LS + DFT 插值
fprintf('--- LS + DFT 插值 ---\n');
[~, H_full_dft] = ls_channel_est(Y, pilot_val, cfg.pilot_idx, cfg.N, 'dft');

%% 3. 均衡
X_eq_lin = Y ./ H_full_lin;
X_eq_dft = Y ./ H_full_dft;

%% 4. EVM / MSE
err_lin = H_full_lin - H_true;
err_dft = H_full_dft - H_true;

mse_lin = mean(abs(err_lin).^2);
mse_dft = mean(abs(err_dft).^2);

fprintf('\n--- 性能对比 ---\n');
fprintf('  LS+Linear MSE: %.2f dB\n', 10*log10(mse_lin));
fprintf('  LS+DFT    MSE: %.2f dB\n', 10*log10(mse_dft));

%% 5. 绘图
if cfg.plot_en
    figure('Position', [100 100 1200 800]);

    % 信道幅频响应
    subplot(2,2,1);
    plot(abs(H_true), 'k-', 'LineWidth', 2); hold on;
    plot(abs(H_full_lin), 'b-', 'LineWidth', 1.2);
    plot(abs(H_full_dft), 'r--', 'LineWidth', 1.2);
    stem(cfg.pilot_idx, abs(H_true(cfg.pilot_idx)), 'ko', 'MarkerSize', 8);
    xlabel('子载波索引'); ylabel('|H|'); title('信道频域响应');
    legend('真实', 'LS+线性', 'LS+DFT', '导频位置', 'Location', 'best');
    grid on;

    % 信道相位
    subplot(2,2,2);
    plot(angle(H_true), 'k-', 'LineWidth', 2); hold on;
    plot(angle(H_full_lin), 'b-', 'LineWidth', 1.2);
    plot(angle(H_full_dft), 'r--', 'LineWidth', 1.2);
    xlabel('子载波索引'); ylabel('相位 (rad)'); title('信道相位响应');
    legend('真实', 'LS+线性', 'LS+DFT', 'Location', 'best');
    grid on;

    % 星座图 (均衡后)
    subplot(2,2,3);
    plot(real(X_eq_lin(cfg.data_idx)), imag(X_eq_lin(cfg.data_idx)), 'b.', 'MarkerSize', 4);
    hold on;
    plot(real(X(cfg.data_idx)), imag(X(cfg.data_idx)), 'ro', 'MarkerSize', 3);
    xlabel('I'); ylabel('Q'); title(sprintf('均衡后星座 (LS+线性, MSE=%.1f dB)', 10*log10(mse_lin)));
    axis equal; grid on;

    subplot(2,2,4);
    plot(real(X_eq_dft(cfg.data_idx)), imag(X_eq_dft(cfg.data_idx)), 'r.', 'MarkerSize', 4);
    hold on;
    plot(real(X(cfg.data_idx)), imag(X(cfg.data_idx)), 'bo', 'MarkerSize', 3);
    xlabel('I'); ylabel('Q'); title(sprintf('均衡后星座 (LS+DFT, MSE=%.1f dB)', 10*log10(mse_dft)));
    axis equal; grid on;

    sgtitle(sprintf('OFDM 信道估计 (SNR=%d dB, %s)', cfg.snr_db, cfg.channel_type));
end

%% 6. 输出汇总
fprintf('\n========================================\n');
fprintf('  仿真完成\n');
fprintf('  LS+Linear MSE: %.1f dB\n', 10*log10(mse_lin));
fprintf('  LS+DFT    MSE: %.1f dB\n', 10*log10(mse_dft));
fprintf('========================================\n');
