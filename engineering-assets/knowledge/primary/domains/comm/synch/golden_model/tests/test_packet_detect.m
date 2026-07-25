function [pass, detail] = test_packet_detect()
    rng(0);  % fix random seed for reproducibility
% 测试1: 包检测概率 — SNR=15dB, 100 次蒙特卡洛
    cfg.N = 64; cfg.N_short = 16; cfg.L_corr = 16;
    cfg.eta_detect = 0.5;
    cfg.N_repeat = 10; cfg.N_gi2 = 32; cfg.N_long = 64;
    cfg.epsilon = 0.3; cfg.tau = 50;

    [~, ~, preamble] = generate_preamble(cfg);
    t_long = preamble(161:224);

    detect_cnt = 0;
    runs = 100;

    for trial = 1:runs
        r = [zeros(cfg.tau,1); preamble];
        L = length(r);
        n = (0:L-1)';
        r = r .* exp(1j*2*pi*cfg.epsilon*n/cfg.N);
        snr = 15;
        sig_pow = mean(abs(r).^2);
        noise = sqrt(sig_pow/10^(snr/10)/2) * (randn(L,1)+1j*randn(L,1));
        r = r + noise;

        [detected, ~, ~] = packet_detect(r, cfg);
        if detected, detect_cnt = detect_cnt + 1; end
    end

    detect_rate = detect_cnt / runs;
    assert(detect_rate > 0.95, '检测率 %.1f%% < 95%%', detect_rate*100);
    pass = true; detail = sprintf('检测率=%.1f%%', detect_rate*100);
end
