function [pass, detail] = test_snr_robust()
    rng(0);  % fix random seed for reproducibility
% 测试5: SNR 鲁棒性 — CFO 误差随 SNR 下降而改善
    config;   % 权威配置: 各测试原先自建一份残缺 cfg (缺 short_len 等),
              % generate_preamble 直接报 "无法识别的字段名称", 5 个测试从未跑通过。
              % 下面各行保留为本测试的特有覆盖。
    cfg.N = 64; cfg.N_short = 16; cfg.L_corr = 16;
    cfg.eta_detect = 0.5; cfg.N_repeat = 10;
    cfg.N_gi2 = 32; cfg.N_long = 64;
    cfg.tau = 50; cfg.epsilon = 0.3;

    [~, ~, preamble] = generate_preamble(cfg);

    errs = [];
    for snr = [0, 5, 10, 15, 20]
        detect_cnt = 0;
        err_sum = 0;
        trials = 50;

        for t = 1:trials
            r = [zeros(cfg.tau,1); preamble];
            L = length(r);
            n = (0:L-1)';
            r = r .* exp(1j*2*pi*cfg.epsilon*n/cfg.N);
            sig_pow = mean(abs(r).^2);
            noise = sqrt(sig_pow/10^(snr/10)/2) * (randn(L,1)+1j*randn(L,1));
            r = r + noise;

            [detected, n_peak, ~] = packet_detect(r, cfg);
            if detected
                eps_est = coarse_cfo_est(r, n_peak, cfg);
                err_sum = err_sum + abs(eps_est - cfg.epsilon);
                detect_cnt = detect_cnt + 1;
            end
        end

        if detect_cnt > 0
            errs = [errs, err_sum / detect_cnt]; %#ok<AGROW>
        end
    end

    % 误差应随 SNR 增加而单调下降
    assert(all(diff(errs) <= 0) || length(errs) < 3, ...
        'CFO 误差不单调: %s', mat2str(errs, 3));
    assert(errs(end) < 0.05, 'SNR=20dB CFO 误差 %.4f > 0.05', errs(end));
    pass = true; detail = sprintf('SNR 扫描通过, 末值=%.4f', errs(end));
end
