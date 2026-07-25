function [pass, detail] = test_normal()
    rng(0);  % fix random seed for reproducibility
% 测试1: 正常 QPSK 成形 + EVM 验证

    cfg.alpha       = 0.5;
    cfg.sps         = 4;
    cfg.span        = 8;
    cfg.mod         = 'qpsk';
    cfg.nsym        = 4096;
    cfg.plot_en     = false;
    cfg.verbose     = false;
    cfg.save_vectors = false;
    cfg.quant.Wi = 2; cfg.quant.Wf = 14;
    cfg.quant.Wt = 16; cfg.quant.Wc = 16;

    % 生成符号
    x = (2*randi([0 1], cfg.nsym*2, 1)-1);
    x = x(1:2:end) + 1j*x(2:2:end);
    x = x / sqrt(2);

    % 成形滤波
    [y, y_quant] = rrc_pulse_shaping(x, cfg);

    % 验证: 输出长度正确
    assert(length(y) == cfg.nsym * cfg.sps, ...
        '输出长度错误: %d ≠ %d', length(y), cfg.nsym*cfg.sps);

    % 验证: EVM < -45dB
    evm = calc_evm_db(y_quant, y);
    assert(evm < -45, 'EVM 过高: %.2f dB', evm);

    % 验证: 最佳采样点星座图正确
    y_eye = y(1:cfg.sps:end);
    y_eye = y_eye(cfg.span+1:end-cfg.span);
    expected = x(cfg.span+1:end-cfg.span) / sqrt(2);  % 幅度归一化
    err = mean(abs(y_eye - expected).^2);
    assert(err < 0.01, '星座误差过大: %.6f', err);

    pass = true;
    detail = sprintf('EVM=%.1f dB, err=%.4f', evm, err);
end

function evm = calc_evm_db(yq, yf)
    err = yq - yf;
    evm = 10*log10(mean(abs(err).^2) / mean(abs(yf).^2));
end
