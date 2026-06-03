%% ===========================================================================
%  LDPC — 一键 BER 仿真 (纯 MATLAB 参考模型)
%  对比 Uncoded BPSK vs LDPC Min-Sum
% ============================================================================
clear; clc; close all;
addpath(fileparts(mfilename('fullpath')));
addpath(fullfile(pwd, 'src'));

config;

fprintf('========================================\n');
fprintf('  802.11n LDPC BER 仿真\n');
fprintf('  N=%d, K=%d, R=%.2f, Z=%d\n', cfg.N, cfg.K, cfg.R, cfg.Z);
fprintf('  Min-Sum alpha=%.2f, max_iter=%d\n', cfg.scale_factor, cfg.max_iter);
fprintf('========================================\n\n');

%% 生成校验矩阵
fprintf('[1/3] 生成 H 矩阵 ... ');
H = generate_h_matrix(cfg);
fprintf('done (%dx%d, %.2f%% 密度)\n', size(H,1), size(H,2), ...
    100 * nnz(H) / numel(H));

%% Uncoded BER (理论)
fprintf('[2/3] Uncoded BPSK 理论 BER ...\n');
snr_lin = 10.^(cfg.snr_list / 10);
ber_uncoded = 0.5 * erfc(sqrt(snr_lin));

%% Min-Sum 译码 BER
fprintf('[3/3] Min-Sum 译码 BER 扫描 (802.11n QC-LDPC) ...\n');
ber_ms = zeros(size(cfg.snr_list));
iter_ms = zeros(size(cfg.snr_list));

for i = 1:length(cfg.snr_list)
    [ber_ms(i), iter_ms(i)] = sim_ldpc_ber(cfg.snr_list(i), cfg, H);
    fprintf('  SNR=%3.1f dB: BER=%.2e, avg_iter=%.1f\n', ...
        cfg.snr_list(i), ber_ms(i), iter_ms(i));
end

%% 绘图
figure('Position', [100, 100, 800, 500]);
semilogy(cfg.snr_list, ber_uncoded, 'k--', 'LineWidth', 1.5); hold on;
semilogy(cfg.snr_list, ber_ms, 'b-o', 'LineWidth', 1.5, 'MarkerSize', 6);
grid on;
xlabel('E_b/N_0 (dB)'); ylabel('BER');
title(sprintf('802.11n LDPC R=%.2f N=%d BER (纯 MATLAB 参考)', cfg.R, cfg.N));
legend('Uncoded BPSK', 'Min-Sum alpha=0.75', 'Location', 'southwest');
xlim([cfg.snr_list(1), cfg.snr_list(end)]);

save('ldpc_ber_results.mat', 'cfg', 'ber_uncoded', 'ber_ms', 'iter_ms');
fprintf('\n结果已保存至 ldpc_ber_results.mat\n');
fprintf('========================================\n');
