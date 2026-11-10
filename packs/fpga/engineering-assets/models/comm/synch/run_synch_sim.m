%% ===========================================================================
%  OFDM 同步 — 主仿真 + RTL 向量导出 (ADR-003)
% ============================================================================
clear; clc; close all;
config;

% 固定随机种子: 本脚本导出的向量是 RTL 的验收证据, 必须可复现。
% 治理规范 G-C-05 要求"同 seed 双跑 bit-identical"; 无种子则每次导出的
% 期望值都不同, 任何比对结果都无法复查。
rng(20260726, 'twister');

fprintf('=== OFDM 同步仿真 ===\n');
fprintf('CFO=%.2f DFT, SNR=%d dB, tau=%d samples\n\n', ...
    cfg.epsilon, cfg.snr_db, cfg.tau);

%% 1. 生成前导码
[short_preamble, long_preamble, preamble] = generate_preamble(cfg);
t_long = long_preamble(33:96);  % T1 (64 samples)

%% 1b. 数据符号 (ADR-003: 向量延长至 >=2048)
%  MODEL-STATUS §4 未决项裁决为"加数据符号": 追加 nsym_data 个 QPSK-OFDM
%  符号 (CP16+64)。RTL 镜像延迟 384 拍 -> 期望行数 = 总长-384, 需总长 >=2432:
%  tau(50)+前导(320)+28×80 = 2610 -> 期望 2226 >= 2048。
nsym_data = 28;
sc_idx_53 = [39:cfg.N, 1, 2:27];
used_mask = true(53,1); used_mask(27) = false;   % DC 不用
data_td = zeros(nsym_data * (cfg.N + cfg.N_cp), 1);
for s = 1:nsym_data
    Xf = zeros(cfg.N, 1);
    bits = randi([0 3], 52, 1);
    qpsk = ((1-2*bitget(bits,1)) + 1j*(1-2*bitget(bits,2))) / sqrt(2);
    idx53 = sc_idx_53(used_mask);
    Xf(idx53) = qpsk;
    xt = ifft(fftshift(Xf));
    data_td((s-1)*80+1 : s*80) = [xt(end-cfg.N_cp+1:end); xt];
end

%% 2. 构造接收信号 (含 CFO + 定时偏移 + 噪声)
r_raw = [zeros(cfg.tau, 1); preamble; data_td];
L = length(r_raw);

% CFO
n = (0:L-1)';
r_cfo = r_raw .* exp(1j * 2 * pi * cfg.epsilon * n / cfg.N);

% AWGN
signal_power = mean(abs(r_cfo).^2);
noise_power = signal_power / 10^(cfg.snr_db/10);
noise = sqrt(noise_power/2) * (randn(L,1) + 1j*randn(L,1));
r = r_cfo + noise;

%% 3. 包检测 (粗定时) — 浮点 golden 链 (健康度参考)
[detected, n_peak, M] = packet_detect(r, cfg);
fprintf('包检测: %s, 粗定时 n=%d\n', string(detected), n_peak);

%% 4. 粗 CFO 估计
if detected
    epsilon_coarse = coarse_cfo_est(r, n_peak, cfg);
    fprintf('粗 CFO: 实际=%.4f, 估计=%.4f, 误差=%.4f\n', ...
        cfg.epsilon, epsilon_coarse, abs(cfg.epsilon-epsilon_coarse));
else
    epsilon_coarse = 0;
    fprintf('CFO 估计: 跳过 (未检测到包)\n');
end

%% 5. CFO 补偿 (浮点批改 — 仅作健康度参考, 向量语义已按 ADR-003 作废)
r_corrected = cfo_correct(r, epsilon_coarse, cfg.N);

%% 6. 精定时 (浮点参考)
n_fine = fine_timing(r_corrected, n_peak, t_long, cfg);
fprintf('精定时: n=%d, 误差=%d samples\n', ...
    n_fine, abs(n_fine - (cfg.tau + 192)));

%% 7. 精 CFO 估计 (限于长前导码区域, 浮点参考; 不在 RTL 范围)
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

%% 9. 导出 RTL 对标向量 (ADR-003: generate_vectors = sync_top RTL 位真镜像)
%  期望 = 因果校正流 (镜像整数语义, 0 容差判卷), 旧浮点批改语义作废。
%  t_long 供 T1 符号量化系数表导出 (RTL sync_correlator 逐位核对)。
generate_vectors(r, t_long, cfg);

fprintf('\n仿真完成\n');
