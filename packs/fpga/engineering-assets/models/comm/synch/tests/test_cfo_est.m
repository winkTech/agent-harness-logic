function [pass, detail] = test_cfo_est()
    rng(0);  % fix random seed for reproducibility
% 测试2: CFO 估计精度 — 粗 CFO 误差 < 10%
    config;   % 权威配置: 各测试原先自建一份残缺 cfg (缺 short_len 等),
              % generate_preamble 直接报 "无法识别的字段名称", 5 个测试从未跑通过。
              % 下面各行保留为本测试的特有覆盖。
    cfg.N = 64; cfg.N_short = 16; cfg.L_corr = 16;
    cfg.eta_detect = 0.5; cfg.N_repeat = 10;
    cfg.N_gi2 = 32; cfg.N_long = 64;
    cfg.epsilon = 0.3; cfg.tau = 50;

    [~, ~, preamble] = generate_preamble(cfg);
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

    epsilon_est = coarse_cfo_est(r, n_peak, cfg);
    err = abs(epsilon_est - cfg.epsilon) / abs(cfg.epsilon);
    assert(err < 0.1, 'CFO 误差 %.1f%% > 10%%', err*100);
    pass = true; detail = sprintf('CFO 误差=%.1f%%', err*100);
end
