function [h, h_quant] = rrc_coeff_gen(cfg)
% <RRC> 生成 RRC 滤波器系数并量化
% 输入:
%   cfg - 配置结构体 (含 alpha, sps, span)
% 输出:
%   h       - 浮点系数向量 [ntaps × 1]
%   h_quant - 量化后系数向量 [ntaps × 1]
%
% 参考: rcosdesign(beta, span, sps, 'sqrt')

    alpha = cfg.alpha;
    sps   = cfg.sps;
    span  = cfg.span;
    ntaps = sps * span + 1;

    %% 生成 RRC 系数 (时域直接计算)
    t = (-(ntaps-1)/2 : (ntaps-1)/2) / sps;  % 以符号周期 Ts 为单位

    % 避免除零
    h = zeros(size(t));
    for i = 1:length(t)
        if abs(t(i)) < 1e-12
            % t = 0
            h(i) = 1 - alpha + 4*alpha/pi;
        elseif abs(abs(t(i)) - 1/(4*alpha)) < 1e-12
            % t = ±Ts/(4α), singularity formula
            % h = α/√2 * [(1+2/π)*sin(π/(4α)) + (1-2/π)*cos(π/(4α))]
            term = pi / (4 * alpha);
            h(i) = alpha/sqrt(2) * ((1+2/pi)*sin(term) + (1-2/pi)*cos(term));
        else
            num = sin(pi*(1-alpha)*t(i)) + 4*alpha*t(i).*cos(pi*(1+alpha)*t(i));
            den = pi*t(i) .* (1 - (4*alpha*t(i)).^2);
            h(i) = num ./ den;
        end
    end

    % 归一化 (保持单位增益)
    h = h / sqrt(sps);

    %% 系数量化
    if isfield(cfg, 'quant') && isfield(cfg.quant, 'Wc')
        Wc = cfg.quant.Wc;          % 系数位宽
        % 确定量化范围: 系数为 Q1.15 格式
        max_val = max(abs(h));
        Wi = ceil(log2(max_val + 1));
        if Wi < 1, Wi = 1; end
        Wf = Wc - Wi;               % 小数位宽

        % 量化
        scale = 2^Wf;
        h_quant = round(h * scale) / scale;

        % 饱和保护
        max_q = 2^(Wc-1) - 1;
        h_quant = min(max(h_quant, -max_q/scale), max_q/scale);

        % 导出系数用于 RTL
        if cfg.save_vectors
            write_coeff_hex(h_quant, 'rrc_coeff.hex', Wc);
        end
    else
        h_quant = h;
    end

    %% 验证
    if cfg.verbose
        fprintf('=== RRC 系数 ===\n');
        fprintf('  滚降系数 α  = %.2f\n', alpha);
        fprintf('  过采样 L    = %d\n', sps);
        fprintf('  跨度        = %d 符号\n', span);
        fprintf('  抽头数      = %d\n', ntaps);
        fprintf('  最大系数    = %.6f\n', max(h));
        fprintf('  最小系数    = %.6f\n', min(h));
        fprintf('  阻带衰减    = %.2f dB\n', ...
            -20*log10(max(abs(h(1:floor(ntaps/4))))));
    end

end

%% ===== 辅助: 导出系数 HEX =====

function write_coeff_hex(h_quant, filename, Wc)
    % 将量化系数导出为十六进制文本文件
    fid = fopen(filename, 'w');
    for i = 1:length(h_quant)
        % 转为补码 hex
        val = round(h_quant(i) * 2^(Wc-1));
        if val < 0
            val = val + 2^Wc;
        end
        fprintf(fid, '%04X\n', val);
    end
    fclose(fid);
    fprintf('  系数已导出: %s (%d 个)\n', filename, length(h_quant));
end
