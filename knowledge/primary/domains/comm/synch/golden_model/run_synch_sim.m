%% ===========================================================================
%  OFDM 同步 — 主仿真 (蒙特卡洛)
% ============================================================================
clear; clc; close all;
config;

fprintf('=== OFDM 同步仿真 ===\n');
fprintf('CFO=%.2f DFT, SNR=%d dB, tau=%d samples\n\n', ...
    cfg.epsilon, cfg.snr_db, cfg.tau);

%% 1. 生成前导码
[short_preamble, long_preamble, preamble] = generate_preamble(cfg);
t_long = long_preamble(33:96);  % T1 (64 samples)

%% 2. 构造接收信号 (含 CFO + 定时偏移 + 噪声)
r_raw = [zeros(cfg.tau, 1); preamble];  % 定时偏移
L = length(r_raw);

% CFO
n = (0:L-1)';
r_cfo = r_raw .* exp(1j * 2 * pi * cfg.epsilon * n / cfg.N);

% AWGN
signal_power = mean(abs(r_cfo).^2);
noise_power = signal_power / 10^(cfg.snr_db/10);
noise = sqrt(noise_power/2) * (randn(L,1) + 1j*randn(L,1));
r = r_cfo + noise;

%% 3. 包检测 (粗定时)
[detected, n_peak, M] = packet_detect(r, cfg);
fprintf('包检测: %s, 粗定时 n=%d\n', ...
    string(detected), n_peak);

%% 4. 粗 CFO 估计
if detected
    epsilon_coarse = coarse_cfo_est(r, n_peak, cfg);
    fprintf('粗 CFO: 实际=%.4f, 估计=%.4f, 误差=%.4f\n', ...
        cfg.epsilon, epsilon_coarse, abs(cfg.epsilon-epsilon_coarse));
else
    epsilon_coarse = 0;
    fprintf('CFO 估计: 跳过 (未检测到包)\n');
end

%% 5. CFO 补偿
r_corrected = cfo_correct(r, epsilon_coarse, cfg);

%% 6. 精定时
n_fine = fine_timing(r_corrected, n_peak, t_long, cfg);
fprintf('精定时: n=%d, 误差=%d samples\n', ...
    n_fine, abs(n_fine - (cfg.tau + 192)));

%% 7. 精 CFO 估计 (限于长前导码区域)
if n_fine + 127 <= length(r_corrected)
    T1 = r_corrected(n_fine:n_fine+63);
    T2 = r_corrected(n_fine+64:n_fine+127);
    epsilon_fine = fine_cfo_est(T1, T2, cfg.N);
    epsilon_total = epsilon_coarse + epsilon_fine;
    fprintf('精 CFO: 估计=%.4f, 总残差=%.4f\n', ...
        epsilon_fine, abs(cfg.epsilon - epsilon_total));
end

%% 8. 绘图
if cfg.plot_en
    figure('Position', [100 100 1200 800]);

    subplot(2,2,1);
    plot(abs(M)); hold on;
    yline(cfg.eta_detect, 'r--', 'Threshold');
    xlabel('Sample'); ylabel('M[n]');
    title('包检测度量'); grid on;
    if detected, xline(n_peak, 'g', 'Detect'); end

    subplot(2,2,2);
    plot(real(r), 'b'); hold on;
    plot(imag(r), 'r');
    xlabel('Sample'); ylabel('Amplitude');
    title('接收信号 (含 CFO)'); grid on;
    if detected, xline(n_peak, 'g', '粗定时'); end

    subplot(2,2,3);
    [corr_lag, R] = xcorr(r_corrected, t_long);
    plot(corr_lag, abs(R));
    xlabel('Lag'); ylabel('|R|');
    title('长前导码互相关'); grid on;

    subplot(2,2,4);
    scatter(real(preamble(1:160)), imag(preamble(1:160)), 5, 'filled');
    xlabel('I'); ylabel('Q');
    title('短前导码星座'); grid on; axis equal;

    sgtitle(sprintf('OFDM 同步仿真 (CFO=%.2f, SNR=%ddB)', ...
        cfg.epsilon, cfg.snr_db));
end

fprintf('\n仿真完成\n");
