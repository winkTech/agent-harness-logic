%% ===========================================================================
%  RRC 成形滤波器 — 主仿真
%  功能: 验证 RRC 脉冲成形，分析 EVM、频谱、眼图
% ============================================================================
clear; clc; close all;
addpath(fileparts(mfilename('fullpath')));

%% 配置
cfg.alpha       = 0.5;      % 滚降系数
cfg.sps         = 4;        % 过采样倍数
cfg.span        = 8;        % 滤波器跨度
cfg.mod         = '16qam';  % 调制方式
cfg.nsym        = 4096;     % 符号数
cfg.plot_en     = true;
cfg.verbose     = true;
cfg.save_vectors = true;

% 量化参数
cfg.quant.Wi = 2;
cfg.quant.Wf = 14;
cfg.quant.Wt = 16;
cfg.quant.Wc = 16;
cfg.quant.Wa = 38;

fprintf('========================================\n');
fprintf('  RRC 脉冲成形仿真\n');
fprintf('  滚降系数: %.2f, 过采样: %d, 跨度: %d\n', ...
    cfg.alpha, cfg.sps, cfg.span);
fprintf('========================================\n\n');

%% 1. 生成测试数据
fprintf('--- 生成 %s 调制符号 ---\n', upper(cfg.mod));
x = generate_symbols(cfg.nsym, cfg.mod);

%% 2. RRC 脉冲成形
fprintf('--- RRC 脉冲成形 ---\n');
tic;
[y, y_quant] = rrc_pulse_shaping(x, cfg);
t_elapsed = toc;
fprintf('  处理时间: %.3f s\n', t_elapsed);

%% 3. 分析
% 3.1 频谱
[Pxx, F] = pwelch(y, 256, 128, 1024, cfg.sps);
[Pxx_q, ~] = pwelch(y_quant, 256, 128, 1024, cfg.sps);

% 3.2 眼图 (取实数部)
eye_data = real(reshape(y(1:cfg.sps*200), cfg.sps, []));

% 3.3 EVM
evm = calc_evm_metric(y_quant, y);

if cfg.plot_en
    figure('Position', [100 100 1200 800]);

    % 时域波形
    subplot(2,3,1);
    plot(real(y(1:200)), 'b-', 'LineWidth', 1); hold on;
    plot(imag(y(1:200)), 'r-', 'LineWidth', 1);
    xlabel('样点'); ylabel('幅度'); title('RRC 输出时域波形');
    legend('I', 'Q'); grid on;

    % 频谱
    subplot(2,3,2);
    F_norm = F / cfg.sps * 2;
    plot(F_norm, 20*log10(abs(Pxx)/max(Pxx)), 'b-', 'LineWidth', 1.5); hold on;
    plot(F_norm, 20*log10(abs(Pxx_q)/max(Pxx_q)), 'r--', 'LineWidth', 1);
    xlabel('归一化频率 (×f_s/2)'); ylabel('PSD (dB)');
    title('RRC 输出频谱'); legend('浮点', '定点');
    xlim([0 1]); ylim([-80 5]); grid on;

    % 眼图
    subplot(2,3,3);
    plot(eye_data, 'b-');
    xlabel('样点/符号'); ylabel('幅度'); title(sprintf('眼图 (α=%.2f)', cfg.alpha));
    grid on;

    % 星座图 (过采样后最佳采样点)
    subplot(2,3,4);
    y_eye = y(1:cfg.sps:end);  % 最佳采样点
    y_eye = y_eye(span+1:end-span);  % 忽略边缘
    plot(real(y_eye), imag(y_eye), 'b.', 'MarkerSize', 4);
    xlabel('I'); ylabel('Q'); title('最佳采样点星座图');
    axis equal; grid on;

    % 星座图 (定点)
    subplot(2,3,5);
    yq_eye = y_quant(1:cfg.sps:end);
    yq_eye = yq_eye(cfg.span+1:end-cfg.span);
    plot(real(yq_eye), imag(yq_eye), 'r.', 'MarkerSize', 4);
    xlabel('I'); ylabel('Q'); title(sprintf('定点星座图 (EVM=%.1f dB)', evm));
    axis equal; grid on;

    % 脉冲响应
    subplot(2,3,6);
    [h, h_q] = rrc_coeff_gen(cfg);
    stem(h, 'b-', 'LineWidth', 1); hold on;
    stem(h_q, 'r--', 'LineWidth', 1);
    xlabel('抽头'); ylabel('幅度'); title('RRC 冲激响应');
    legend('浮点', '定点'); grid on;

    sgtitle(sprintf('RRC 脉冲成形 (α=%.2f, L=%d, span=%d)', ...
        cfg.alpha, cfg.sps, cfg.span));
end

%% 4. 导出测试向量
if cfg.save_vectors
    fprintf('\n--- 导出测试向量 ---\n');
    export_test_vectors(x, y, y_quant, cfg);
end

%% 5. 结果汇总
fprintf('\n========================================\n');
fprintf('  仿真完成\n');
fprintf('  EVM (定点)  = %.2f dB\n', evm);
fprintf('  阻带衰减    = %.2f dB\n', ...
    -20*log10(max(abs(Pxx(end-50:end)))));
fprintf('  符号数      = %d\n', cfg.nsym);
fprintf('  输出样点数  = %d\n', length(y));
fprintf('========================================\n');

%% ===== 辅助函数 =====

function x = generate_symbols(nsym, mod_type)
    % 生成调制符号
    switch lower(mod_type)
        case 'qpsk'
            bits = randi([0 1], nsym*2, 1);
            x = (2*bits(1:2:end)-1) + 1j*(2*bits(2:2:end)-1);
            x = x / sqrt(2);  % 归一化
        case '16qam'
            bits = randi([0 1], nsym*4, 1);
            x = qammod(bi2de(reshape(bits, 4, [))', 16, 'gray', ...
                'InputType', 'bit', 'UnitAveragePower', true);
            x = x(:);
        case '64qam'
            bits = randi([0 1], nsym*6, 1);
            x = qammod(bi2de(reshape(bits, 6, [))', 64, 'gray', ...
                'InputType', 'bit', 'UnitAveragePower', true);
            x = x(:);
        otherwise
            error('不支持调制方式: %s', mod_type);
    end
end

function evm = calc_evm_metric(y_quant, y_float)
    % 计算 EVM (dB)
    err = y_quant - y_float;
    p_signal = mean(abs(y_float).^2);
    p_noise  = mean(abs(err).^2);
    evm = 10 * log10(p_noise / p_signal);
end

function export_test_vectors(x_in, y_out, y_quant, cfg)
    % 导出测试向量
    base_name = sprintf('rrc_test_%s_alpha%.2f_sps%d', ...
        cfg.mod, cfg.alpha, cfg.sps);

    % 输入符号
    fid = fopen(sprintf('%s_input.hex', base_name), 'w');
    for i = 1:min(length(x_in), 2048)
        fprintf(fid, '%04X%04X\n', ...
            typecast(int16(round(real(x_in(i))*2^14)), 'uint16'), ...
            typecast(int16(round(imag(x_in(i))*2^14)), 'uint16'));
    end
    fclose(fid);

    % 输出 (float + quant)
    fid = fopen(sprintf('%s_output_float.hex', base_name), 'w');
    for i = 1:min(length(y_out), 2048)
        fprintf(fid, '%04X%04X\n', ...
            typecast(int16(round(real(y_out(i))*2^14)), 'uint16'), ...
            typecast(int16(round(imag(y_out(i))*2^14)), 'uint16'));
    end
    fclose(fid);

    fid = fopen(sprintf('%s_output_quant.hex', base_name), 'w');
    for i = 1:min(length(y_quant), 2048)
        vi = int16(round(real(y_quant(i))*2^14));
        vq = int16(round(imag(y_quant(i))*2^14));
        fprintf(fid, '%04X%04X\n', ...
            typecast(vi, 'uint16'), typecast(vq, 'uint16'));
    end
    fclose(fid);

    fprintf('  测试向量已导出:\n');
    fprintf('    - %s_input.hex\n', base_name);
    fprintf('    - %s_output_float.hex\n', base_name);
    fprintf('    - %s_output_quant.hex\n', base_name);
end
