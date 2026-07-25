function [pass, detail] = test_boundary()
    rng(0);  % fix random seed for reproducibility
% 测试3: 边界条件 — 滚降系数 0.22/0.35/0.5 + 不同过采样倍数

    cfg.nsym        = 2048;
    cfg.span        = 8;
    cfg.mod         = 'qpsk';
    cfg.plot_en     = false;
    cfg.verbose     = false;
    cfg.save_vectors = false;
    cfg.quant.Wi = 2; cfg.quant.Wf = 14;
    cfg.quant.Wt = 16; cfg.quant.Wc = 16;

    scenarios = {
        0.22, 4, 'α=0.22 窄带'
        0.35, 4, 'α=0.35 中带'
        0.50, 4, 'α=0.50 宽带'
        0.50, 2, 'L=2 低过采样'
        0.50, 8, 'L=8 高过采样'
    };

    x = (2*randi([0 1], cfg.nsym*2, 1)-1);
    x = x(1:2:end) + 1j*x(2:2:end);
    x = x / sqrt(2);

    for i = 1:size(scenarios, 1)
        cfg.alpha = scenarios{i, 1};
        cfg.sps   = scenarios{i, 2};
        name      = scenarios{i, 3};

        [y, ~] = rrc_pulse_shaping(x, cfg);

        % 验证输出长度
        assert(length(y) == cfg.nsym * cfg.sps, ...
            '%s 输出长度错误', name);

        % 验证无 NaN/Inf
        assert(all(isfinite(y)), '%s 含 NaN/Inf', name);

        % 验证幅度不饱和
        assert(max(abs(y)) < 10, '%s 幅度异常', name);
    end

    pass = true;
    detail = sprintf('通过 %d 个场景', size(scenarios, 1));
end
