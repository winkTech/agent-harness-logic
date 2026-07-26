function [pass, detail] = test_timing()
    rng(0);  % fix random seed for reproducibility
% 测试3: 精定时精度 — 误差 < 3 样点
    config;   % 权威配置: 各测试原先自建一份残缺 cfg (缺 short_len 等),
              % generate_preamble 直接报 "无法识别的字段名称", 5 个测试从未跑通过。
              % 下面各行保留为本测试的特有覆盖。
    cfg.N = 64; cfg.N_short = 16; cfg.L_corr = 16;
    cfg.eta_detect = 0.5; cfg.N_repeat = 10;
    cfg.N_gi2 = 32; cfg.N_long = 64;
    cfg.epsilon = 0.3; cfg.tau = 50;

    [~, long_preamble, preamble] = generate_preamble(cfg);
    t_long = long_preamble(33:96);

    r = [zeros(cfg.tau,1); preamble];
    L = length(r);
    n = (0:L-1)';
    r = r .* exp(1j*2*pi*cfg.epsilon*n/cfg.N);

    snr = 20;
    sig_pow = mean(abs(r).^2);
    noise = sqrt(sig_pow/10^(snr/10)/2) * (randn(L,1)+1j*randn(L,1));
    r = r + noise;

    [detected, n_peak, ~] = packet_detect(r, cfg);
    assert(detected, '包检测失败');

    epsilon_coarse = coarse_cfo_est(r, n_peak, cfg);
    r_corr = cfo_correct(r, epsilon_coarse, cfg.N);

    n_fine = fine_timing(r_corr, n_peak, t_long, cfg);
    n_expected = cfg.tau + 160 + 32;  % 长前导码 T1 起始

    timing_err = abs(n_fine - n_expected);
    assert(timing_err < 3, '定时误差 %d 样点', timing_err);
    pass = true; detail = sprintf('定时误差=%d 样点', timing_err);
end
