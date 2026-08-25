function pass = test_rx_cp_window()
%% rx_cp_window 测试: 802.11a 帧结构切窗
%  判据是"切出来的必须逐样点等于放进去的" —— 纯选通逻辑, 不存在容差空间。
    config;
    N = cfg.N; N_cp = cfg.N_cp;
    rng(20260803);

    n_sym = 5;
    t1   = randn(N,1) + 1i*randn(N,1);
    t2   = randn(N,1) + 1i*randn(N,1);
    data = randn(N,n_sym) + 1i*randn(N,n_sym);
    lead = randn(37,1) + 1i*randn(37,1);      % STS/GI2 残留, 长度任取

    % 组流: [前缀][T1][T2]{[CP=尾16][符号]} x n_sym
    stream = [lead; t1; t2];
    for k = 1:n_sym
        stream = [stream; data(end-N_cp+1:end, k); data(:,k)];   %#ok<AGROW>
    end
    fft_start = numel(lead) + 1;

    [grid, info] = rx_cp_window(stream, fft_start, n_sym, cfg);

    % --- 1. 形状与逐样点一致 ---
    pass_shape = isequal(size(grid), [N, 2+n_sym]);
    pass_t1 = isequal(grid(:,1), t1);
    pass_t2 = isequal(grid(:,2), t2);
    pass_data = isequal(grid(:,3:end), data);

    % --- 2. 下标: T1/T2 紧邻不跳 CP; 数据符号每个跳 16 ---
    pass_idx = info.starts(2) - info.starts(1) == N ...
            && info.starts(3) - info.starts(2) == N + N_cp ...
            && all(diff(info.starts(3:end)) == N + N_cp);

    % --- 3. n_sym = 0 只出 T1/T2 ---
    g0 = rx_cp_window([lead; t1; t2], fft_start, 0, cfg);
    pass_zero = isequal(size(g0), [N,2]) && isequal(g0(:,1), t1) && isequal(g0(:,2), t2);

    % --- 4. 样点不足必须报错, 不得静默截断 ---
    pass_short = false;
    try
        rx_cp_window(stream(1:end-1), fft_start, n_sym, cfg);
    catch ME
        pass_short = strcmp(ME.identifier, 'rx_cp_window:tooShort');
    end

    % --- 5. 非法入参报错 ---
    pass_bad = false;
    try
        rx_cp_window(stream, 0, n_sym, cfg);
    catch ME
        pass_bad = strcmp(ME.identifier, 'rx_cp_window:badStart');
    end

    fprintf('  形状 %d | T1 %d | T2 %d | 数据 %d | 下标 %d | n_sym=0 %d | 样点不足 %d | 非法入参 %d\n', ...
            pass_shape, pass_t1, pass_t2, pass_data, pass_idx, pass_zero, pass_short, pass_bad);
    pass = pass_shape && pass_t1 && pass_t2 && pass_data && pass_idx && pass_zero && pass_short && pass_bad;
end
