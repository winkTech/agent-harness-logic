function [y, y_quant] = rrc_pulse_shaping(x, cfg)
% <RRC> RRC 脉冲成形 (发射链路)
% 输入:
%   x   - 输入符号序列 [nsym × 1] (复数，QPSK/QAM 映射后)
%   cfg - 配置结构体
% 输出:
%   y       - 成形后浮点输出 [nsym*sps × 1]
%   y_quant - 量化后输出

    sps   = cfg.sps;
    alpha = cfg.alpha;
    span  = cfg.span;

    %% 生成系数
    [h, h_quant] = rrc_coeff_gen(cfg);

    %% 零值内插
    x_up = upsample(x, sps);

    %% FIR 滤波
    % 浮点
    y = conv(x_up, h, 'full');

    % 截断延迟: 群延迟 = (ntaps-1)/2 个样本
    delay = (length(h)-1) / 2;
    y = y(delay+1 : delay+length(x_up));

    %% 定点仿真 (系数量化)
    if isfield(cfg, 'quant') && isfield(cfg.quant, 'Wt')
        % 使用量化系数重新滤波
        y_quant_f = conv(x_up, h_quant, 'full');
        y_quant_f = y_quant_f(delay+1 : delay+length(x_up));

        % 输出量化
        Wi = cfg.quant.Wi;
        Wf = cfg.quant.Wf;
        Wt = cfg.quant.Wt;
        scale = 2^Wf;
        max_q = 2^(Wt-1) - 1;

        y_quant = round(y_quant_f * scale) / scale;
        y_quant = min(max(y_quant, -max_q/scale), max_q/scale);

        % 计算 EVM
        evm_val = calc_evm(y_quant_f, y);
        if cfg.verbose
            fprintf('\n  EVM (定点 vs 浮点) = %.2f dB\n', evm_val);
        end
    else
        y_quant = y;
    end

end

%% ===== 辅助函数 =====

function evm = calc_evm(y_quant, y_float)
    % 计算 EVM
    err = y_quant - y_float;
    p_signal = mean(abs(y_float).^2);
    p_noise  = mean(abs(err).^2);
    evm = 10 * log10(p_noise / p_signal);
end
