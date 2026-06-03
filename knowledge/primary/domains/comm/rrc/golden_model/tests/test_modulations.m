function [pass, detail] = test_modulations()
    rng(0);  % fix random seed for reproducibility
% 测试2: 多调制方式验证 (16QAM, 64QAM)

    cfg.alpha       = 0.5;
    cfg.sps         = 4;
    cfg.span        = 8;
    cfg.nsym        = 2048;
    cfg.plot_en     = false;
    cfg.verbose     = false;
    cfg.save_vectors = false;
    cfg.quant.Wi = 2; cfg.quant.Wf = 14;
    cfg.quant.Wt = 16; cfg.quant.Wc = 16;

    mods = {'16qam', '64qam'};
    evm_results = [];

    for m = 1:length(mods)
        cfg.mod = mods{m};

        % 生成调制符号
        switch lower(cfg.mod)
            case '16qam'
                x = qammod(randi(16, cfg.nsym, 1)-1, 16, 'gray', ...
                    'UnitAveragePower', true);
            case '64qam'
                x = qammod(randi(64, cfg.nsym, 1)-1, 64, 'gray', ...
                    'UnitAveragePower', true);
        end

        % 成形
        [y, y_quant] = rrc_pulse_shaping(x, cfg);

        % EVM
        err = y_quant - y;
        evm = 10*log10(mean(abs(err).^2) / mean(abs(y).^2));
        evm_results(m) = evm;

        assert(length(y) == cfg.nsym * cfg.sps, ...
            '%s 长度错误', mods{m});
    end

    % 所有调制方式的 EVM 都应 < -45dB
    assert(all(evm_results < -45), ...
        'EVM 超标: %s', mat2str(evm_results, 2));

    pass = true;
    detail = sprintf('16QAM EVM=%.1f dB, 64QAM EVM=%.1f dB', ...
        evm_results(1), evm_results(2));
end
