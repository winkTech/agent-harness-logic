function pass = test_eq_zf()
%% eq_zf 测试: ZF 频域均衡 + 数据子载波提取
%  判据全部解析可知。最强的一条是 T2: 造一个已知信道, 均衡后必须**逐点还原**
%  原始发射符号 —— 这才证明它在做均衡, 而不只是"跑通了"。
    config;
    N = cfg.N;
    rng(20260804);

    n_sym  = 5;
    n_data = numel(cfg.data_idx);
    errors = 0;

    % 数据子载波的 bin (与 rx_chain 同一换算), 供本测试独立算一遍做交叉核对
    bins = zeros(1, n_data);
    for d = 1:n_data
        idx = cfg.data_idx(d);
        if idx < 0, bins(d) = N + idx; else, bins(d) = idx; end
    end

    %% --- T1. 理想信道 H=1: 输出必须等于 Y 的数据子载波 ---
    Y  = randn(N, n_sym) + 1i * randn(N, n_sym);
    H1 = ones(N, n_sym);
    [x1, info1] = eq_zf(Y, H1, cfg);
    t1_shape = isequal(size(x1), [n_data, n_sym]);
    t1_val   = max(abs(x1(:) - reshape(Y(bins + 1, :), [], 1))) < 1e-12;
    t1_bins  = isequal(info1.bins, bins);
    if ~(t1_shape && t1_val && t1_bins), errors = errors + 1; end
    fprintf('  [T1] H=1 恒等: 形状 %d | 逐点 %d | bins 与 rx_chain 一致 %d\n', ...
            t1_shape, t1_val, t1_bins);

    %% --- T2. 已知信道端到端: 均衡后必须还原原始符号 ---
    % 造发射符号 -> 过已知信道 -> 均衡 -> 应逐点回到发射符号
    X_tx = (2*randi([0 1], n_data, n_sym) - 1) + 1i * (2*randi([0 1], n_data, n_sym) - 1);
    % 信道: 各子载波独立复增益, 幅度 0.3~1.7 (避开深衰落, 深衰落单独在 T4 看)
    Hd   = (0.3 + 1.4*rand(n_data, n_sym)) .* exp(1i * 2*pi*rand(n_data, n_sym));

    Yfull = zeros(N, n_sym);  Hfull = ones(N, n_sym);
    Yfull(bins + 1, :) = X_tx .* Hd;
    Hfull(bins + 1, :) = Hd;

    x2 = eq_zf(Yfull, Hfull, cfg);
    t2_err = max(abs(x2(:) - X_tx(:)));
    t2 = t2_err < 1e-12;
    if ~t2, errors = errors + 1; end
    fprintf('  [T2] 端到端还原: 最大误差 %.3e (须 < 1e-12): %d\n', t2_err, t2);

    %% --- T3. 只取数据子载波: 导频/DC/保护带的值改动不得影响输出 ---
    Ypert = Yfull;  Hpert = Hfull;
    non_data = setdiff(0:N-1, bins);
    Ypert(non_data + 1, :) = 1e6 * (randn(numel(non_data), n_sym) + 1i*randn(numel(non_data), n_sym));
    Hpert(non_data + 1, :) = 1e-9;                    % 非数据载波给近零 H
    x3 = eq_zf(Ypert, Hpert, cfg);
    t3 = isequal(x3, x2);
    if ~t3, errors = errors + 1; end
    fprintf('  [T3] 非数据载波隔离: 把它们的 Y 放大 1e6、H 压到 1e-9, 输出不变: %d\n', t3);

    %% --- T4. ZF 的代价必须被如实报出 (深衰落 -> 噪声放大) ---
    Hdeep = Hfull;  Hdeep(bins(1) + 1, :) = 0.01;      % 一个深衰落载波
    [~, info4] = eq_zf(Yfull, Hdeep, cfg);
    t4 = abs(info4.zf_noise_gain(1,1) - 1/(0.01^2)) < 1e-6 ...
      && abs(info4.min_h_mag2 - 0.01^2) < 1e-12;
    if ~t4, errors = errors + 1; end
    fprintf('  [T4] 深衰落 |H|=0.01: zf_noise_gain=%.1f (=1/|H|^2), min_h_mag2 如实报出: %d\n', ...
            info4.zf_noise_gain(1,1), t4);

    %% --- T5. |H|=0 必须报错, 不得静默产出 Inf/NaN ---
    Hzero = Hfull;  Hzero(bins(3) + 1, 2) = 0;
    t5 = false;
    try
        eq_zf(Yfull, Hzero, cfg);
    catch ME
        t5 = strcmp(ME.identifier, 'eq_zf:singular');
    end
    if ~t5, errors = errors + 1; end
    fprintf('  [T5] |H|=0 报错而非静默出 Inf/NaN: %d\n', t5);

    %% --- T6. 维度不符必须报错 ---
    t6 = false;
    try
        eq_zf(Yfull, Hfull(:, 1:end-1), cfg);
    catch ME
        t6 = strcmp(ME.identifier, 'eq_zf:dim');
    end
    if ~t6, errors = errors + 1; end
    fprintf('  [T6] Y/H 符号数不一致必须报错: %d\n', t6);

    pass = (errors == 0);
end
