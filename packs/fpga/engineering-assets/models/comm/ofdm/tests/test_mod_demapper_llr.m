function pass = test_mod_demapper_llr()
%% mod_demapper_llr 测试: 软判决解调 (max-log LLR)
%  最强的一条是 T3: 对 LLR 取硬判决后, 必须与治理侧的 mod_demapper **逐比特相同**。
%  它把新锚绑在了已认证的硬判决路径上 —— 符号约定若翻反, 这条立刻红。
%
%  为什么符号约定值得单独盯: 两个 golden 族的比特-符号映射方向相反
%    models/comm/ofdm  mod_mapper.m:           s = 2b - 1   (bit 1 -> +1)
%    models/comm/ldpc  gen_rtl_test_vectors.m: tx = 1 - 2c  (正 LLR = bit 0)
%  下游是 ldpc_codec, 故本锚按后者输出。搞错这个号, 译码器会整体失效, 而现象看着像
%  "译码器不工作"而不是"符号反了" —— 那种错最难查, 所以在这里锁死。

    rng(20260805);
    mods   = {'BPSK', 'QPSK', '16QAM', '64QAM'};
    bpsv   = [1 2 4 6];
    errors = 0;

    %% --- T1. BPSK 闭式: LLR = -2y/sigma2 ---
    % 由 log P(b=0)/P(b=1) = [-(y+1)^2 + (y-1)^2]/(2 sigma2) 直接得出, 不留容差空间
    y  = [-1.5; -0.3; 0.0; 0.7; 2.0];
    L  = mod_demapper_llr(y, 1, 'BPSK', 1);
    t1 = max(abs(L(:) - (-2 * y))) < 1e-12;
    if ~t1, errors = errors + 1; end
    fprintf('  [T1] BPSK 闭式 LLR=-2y: 最大偏差 %.3g\n', max(abs(L(:) - (-2 * y))));

    %% --- T2. 符号约定: bit0 -> 正 LLR, bit1 -> 负 LLR ---
    t2 = true;
    for k = 1:4
        bps = bpsv(k);
        L0 = mod_demapper_llr(mod_mapper(zeros(bps,1), mods{k}), 1, mods{k}, 1);
        L1 = mod_demapper_llr(mod_mapper(ones(bps,1),  mods{k}), 1, mods{k}, 1);
        if any(L0 <= 0) || any(L1 >= 0), t2 = false; end
    end
    if ~t2, errors = errors + 1; end
    fprintf('  [T2] 符号约定 (bit0->正 / bit1->负) 四调制: %d\n', t2);

    %% --- T3. 与治理侧硬判决 golden 逐比特一致 (主判据) ---
    t3 = true;
    for k = 1:4
        bps = bpsv(k);
        b   = randi([0 1], bps * 200, 1);
        s   = mod_mapper(b, mods{k});
        L   = mod_demapper_llr(s, 1, mods{k}, 1);
        hard_llr = double(L(:) < 0);              % 负 LLR -> bit 1
        d_golden = sum(hard_llr ~= mod_demapper(s, mods{k}));
        d_orig   = sum(hard_llr ~= b);
        if d_golden ~= 0 || d_orig ~= 0, t3 = false; end
        fprintf('  [T3] %-6s 对 mod_demapper 差 %d 比特 | 对原始比特差 %d\n', ...
                mods{k}, d_golden, d_orig);
    end
    if ~t3, errors = errors + 1; end

    %% --- T4. erasure: w=0 -> LLR 恒 0, 且不影响邻居 ---
    s  = mod_mapper(randi([0 1], 4*10, 1), '16QAM');
    ww = ones(size(s)); ww(3) = 0;
    [L, info] = mod_demapper_llr(s, ww, '16QAM', 1);
    Lm = reshape(L, 4, []);
    t4 = all(Lm(:,3) == 0) && all(any(Lm(:, [1 2 4:end]) ~= 0, 1)) && info.n_erasure == 1;
    if ~t4, errors = errors + 1; end
    fprintf('  [T4] erasure (w=0) -> LLR 恒 0 且不伤邻居: %d\n', t4);

    %% --- T5. 逐载波权重必须线性 ---
    % 这条锁的是裁定⑤ 的实际效果: 权重若被吞掉或非线性, 深衰落载波的置信度就不对
    L1 = mod_demapper_llr(s, 1,   '16QAM', 1);
    L3 = mod_demapper_llr(s, 3.0, '16QAM', 1);
    t5 = max(abs(L3 - 3*L1)) < 1e-12;
    if ~t5, errors = errors + 1; end
    fprintf('  [T5] 权重线性 (w=3 -> 3 倍): 最大偏差 %.3g\n', max(abs(L3 - 3*L1)));

    %% --- T6. 形状: [N*bps x K] ---
    X  = reshape(mod_mapper(randi([0 1], 4*48*5, 1), '16QAM'), 48, 5);
    L  = mod_demapper_llr(X, ones(size(X)), '16QAM', 1);
    t6 = isequal(size(L), [192 5]);
    if ~t6, errors = errors + 1; end
    fprintf('  [T6] 形状 %s (期望 [192 5])\n', mat2str(size(L)));

    %% --- T7. 非法入参必须报错 ---
    t7 = false;
    try
        mod_demapper_llr(y, 1, 'QAM256', 1);
    catch ME
        t7 = strcmp(ME.identifier, 'mod_demapper_llr:mod');
    end
    t7b = false;
    try
        mod_demapper_llr(y, -1, 'BPSK', 1);       % w 是 |H|^2, 不得为负
    catch ME
        t7b = strcmp(ME.identifier, 'mod_demapper_llr:weight');
    end
    if ~(t7 && t7b), errors = errors + 1; end
    fprintf('  [T7] 非法调制 %d | 负权重 %d 均报错\n', t7, t7b);

    pass = (errors == 0);
end
