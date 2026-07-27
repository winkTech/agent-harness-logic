function pass = test_boundary()
%% 边界测试: 全零输入、单频输入
    config;   % config.m 是脚本不是函数, 原写法 cfg=config() 直接报错
    cfg.plot_en = false;
    cfg.save_vectors = false;
    N = cfg.N;

    % 测试1: 全零频域输入 → IFFT输出全零
    % 跳过完整tx_chain, 直接测试ifft_chain
    freq_zero = zeros(N, 1);
    time_zero = ifft_chain(freq_zero, cfg);
    pass_zero = max(abs(time_zero(:))) < 1e-15;

    % 测试2: 单频输入 (仅DC子载波有值) → 时域直流
    freq_dc = zeros(N, 1);
    freq_dc(33) = 1;  % DC在FFT shift后的第33个位置
    time_dc = ifft_chain(freq_dc, cfg);
    % DC激励产生常数时域输出
    pass_dc = max(abs(diff(time_dc))) < 1e-10;

    pass = pass_zero && pass_dc;

    fprintf('  全零输入: %s\n', string(pass_zero));
    fprintf('  单频输入: %s\n', string(pass_dc));
end
