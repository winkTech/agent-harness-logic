function [pass, detail] = test_quantization()
    rng(0);  % fix random seed for reproducibility
% 测试4: 定点量化分析 — 12位/16位系数对比

    cfg.alpha = 0.5; cfg.sps = 4;
    cfg.span = 8; cfg.nsym = 2048;
    cfg.mod = '16qam';
    cfg.plot_en = false; cfg.verbose = false;
    cfg.save_vectors = false;
    cfg.quant.Wi = 2; cfg.quant.Wf = 14;
    cfg.quant.Wt = 16;

    % 原始数据
    x = qammod(randi(16, cfg.nsym, 1)-1, 16, 'gray', ...
        'UnitAveragePower', true);

    % 12 位系数
    cfg.quant.Wc = 12;
    [~, y12] = rrc_pulse_shaping(x, cfg);

    % 16 位系数
    cfg.quant.Wc = 16;
    [~, y16] = rrc_pulse_shaping(x, cfg);

    % 32 位系数 (基准)
    cfg.quant.Wc = 32;
    [~, y32] = rrc_pulse_shaping(x, cfg);

    % 计算 EVM
    evm12 = 10*log10(mean(abs(y12-y32).^2) / mean(abs(y32).^2));
    evm16 = 10*log10(mean(abs(y16-y32).^2) / mean(abs(y32).^2));

    % 16 位应显著优于 12 位
    assert(evm16 < -50, '16位 EVM 过高: %.2f dB', evm16);
    assert(evm16 < evm12, '16位未优于12位');
    assert((evm12 - evm16) > 3, '量化改善不足: %.1f dB', evm12-evm16);

    pass = true;
    detail = sprintf('12位 EVM=%.1f dB, 16位 EVM=%.1f dB', evm12, evm16);
end
