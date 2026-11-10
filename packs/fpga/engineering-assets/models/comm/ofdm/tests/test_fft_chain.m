function pass = test_fft_chain()
%% fft_chain 测试: 与 ifft_chain 互逆、自然序契约、以及提取不改变 rx_chain 行为
    config;
    cfg.plot_en = false; cfg.save_vectors = false;
    N = cfg.N;
    tol = 1e-12;

    % --- 1. 与 ifft_chain 严格互逆 (随机频域网格往返) ---
    rng(20260803);
    freq_in  = (randn(N,4) + 1i*randn(N,4)) / sqrt(2);
    time_mid = ifft_chain(freq_in, cfg);
    freq_out = fft_chain(time_mid, cfg);
    err_rt   = max(abs(freq_out(:) - freq_in(:)));
    pass_rt  = err_rt < tol;

    % --- 2. 自然序契约: DC 激励 → 时域常数 → 变回来仍只有位置 1 ---
    %     (与 test_boundary 的 ifft 侧同一约定, 防 fftshift 回潮)
    freq_dc = zeros(N,1); freq_dc(1) = 1;
    time_dc = ifft_chain(freq_dc, cfg);
    back    = fft_chain(time_dc, cfg);
    pass_dc = abs(back(1) - 1) < tol && max(abs(back(2:end))) < tol ...
              && max(abs(diff(time_dc))) < 1e-10;

    % --- 3. Nyquist 位置 (N/2+1) 不被误当 DC ---
    freq_nq = zeros(N,1); freq_nq(N/2+1) = 1;
    time_nq = ifft_chain(freq_nq, cfg);
    back_nq = fft_chain(time_nq, cfg);
    pass_nq = abs(back_nq(N/2+1) - 1) < tol && max(abs(back_nq([1:N/2 N/2+2:N]))) < tol;

    % --- 4. 提取不改变 rx_chain 的既有行为 (逐位相同, 非近似) ---
    %     rx_chain 内联的是 fft(x)/sqrt(N); fft_chain 必须与之逐位一致。
    rng(7);
    ts = randn(N,6) + 1i*randn(N,6);
    inline_ref = zeros(N,6);
    for k = 1:6
        inline_ref(:,k) = fft(ts(:,k), N) / sqrt(N);
    end
    pass_same = isequal(inline_ref, fft_chain(ts, cfg));

    % --- 5. 维度校验会报错 ---
    pass_dim = false;
    try
        fft_chain(zeros(N+1, 1), cfg);
    catch ME
        pass_dim = strcmp(ME.identifier, 'fft_chain:dimMismatch');
    end

    fprintf('  往返恒等 err=%.3e | DC 自然序 %d | Nyquist 定位 %d | 与内联逐位相同 %d | 维度校验 %d\n', ...
            err_rt, pass_dc, pass_nq, pass_same, pass_dim);
    pass = pass_rt && pass_dc && pass_nq && pass_same && pass_dim;
end
