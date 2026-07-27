function [pass, detail] = test_cfo_range()
    rng(0);  % fix random seed for reproducibility
% 测试4: CFO 估计范围 — 粗精级联覆盖 [-2, 2]
    config;   % 权威配置: 各测试原先自建一份残缺 cfg (缺 short_len 等),
              % generate_preamble 直接报 "无法识别的字段名称", 5 个测试从未跑通过。
              % 下面各行保留为本测试的特有覆盖。
    cfg.N = 64; cfg.N_short = 16; cfg.L_corr = 16;
    cfg.eta_detect = 0.5; cfg.N_repeat = 10;
    cfg.N_gi2 = 32; cfg.N_long = 64;
    cfg.tau = 50;

    [~, long_preamble, preamble] = generate_preamble(cfg);
    t_long = long_preamble(33:96);

    test_cfos = [-1.5, -0.8, 0, 0.3, 1.2, 1.8];
    max_err = 0;

    for eps_test = test_cfos
        r = [zeros(cfg.tau,1); preamble];
        L = length(r);
        n = (0:L-1)';
        r = r .* exp(1j*2*pi*eps_test*n/cfg.N);
        snr = 20;
        sig_pow = mean(abs(r).^2);
        noise = sqrt(sig_pow/10^(snr/10)/2) * (randn(L,1)+1j*randn(L,1));
        r = r + noise;

        [detected, n_peak, ~] = packet_detect(r, cfg);
        assert(detected, 'CFO=%.1f 时包检测失败', eps_test);

        eps_coarse = coarse_cfo_est(r, n_peak, cfg);
        r_corr = cfo_correct(r, eps_coarse, cfg.N);
        n_fine = fine_timing(r_corr, n_peak, t_long, cfg);

        if n_fine + 127 <= length(r_corr)
            T1 = r_corr(n_fine:n_fine+63);
            T2 = r_corr(n_fine+64:n_fine+127);
            eps_fine = fine_cfo_est(T1, T2, cfg.N);
            eps_total = eps_coarse + eps_fine;
            err = abs(eps_total - eps_test);
            max_err = max(max_err, err);
        end
    end

    assert(max_err < 0.1, 'CFO 最大误差 %.4f > 0.1', max_err);
    pass = true; detail = sprintf('CFO 范围 [-1.5,1.8], 最大误差=%.4f', max_err);
end
