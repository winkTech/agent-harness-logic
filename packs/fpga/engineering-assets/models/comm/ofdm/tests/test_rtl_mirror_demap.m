function ok = test_rtl_mirror_demap()
%TEST_RTL_MIRROR_DEMAP  rtl_mirror_demap 的判据 —— 定点镜像 vs 浮点锚 + 边界语义
%
%   镜像是 RTL 的需求侧事实源, 所以它自己必须被独立锁住。**判据不是"镜像跟自己一致"**
%   (那什么都证明不了), 而是:
%     T1 逐点对**浮点锚** mod_demapper_llr —— 差必须落在 Q(10,4) 的量化地板内
%     T2 擦除语义闭环 (裁定④): erasure -> 全 0; 且 conf=0 也自然得 0 (双保险)
%     T3 饱和而非回绕 —— 极值必须钉在 ±512/511, 回绕会变号, 那是译码器的灾难
%     T4 电平表与轴归属 —— RTL 的 ROM 内容就取这里, 错一个电平全盘错
%     T5 位宽上界与 sh' 值域 —— RTL 照这个开位宽, 上界松了会溢出, 紧了会截断
%     T6 输入契约 —— 浮点符号/越界 conf/BPSK 必须报错而不是算出个数来
%     T7 标定自检 —— 一个可手算闭式验算的点, 防"整体平移一个常数"这类错
%
%   run_all_tests 调用约定: 返回 logical, 失败抛错。

    ok = false;
    fails = 0;

    fprintf('  which(rtl_mirror_demap) = %s\n', which('rtl_mirror_demap'));
    fprintf('  which(mod_demapper_llr) = %s\n', which('mod_demapper_llr'));

    MODS = {'QPSK', '16QAM', '64QAM'};
    BPS  = [2 4 6];
    KDEF = [2 16 32];

    rng(20260805);

    %% ================= T1 对浮点锚: 差必须落在 Q(10,4) 地板内 =================
    % 参照系是**锚自己量化到 Q(10,4)**。两边各自舍入本就会差最多 1 个 LSB, 不可能更小;
    % 超过 1 LSB 就说明定标或舍入点写错了 —— 那是规格错, 不是"精度问题"。
    fprintf('\n  T1 定点镜像 vs 浮点锚 (Q(10,4) 逐点):\n');
    for k = 1:numel(MODS)
        m = MODS{k}; K = KDEF(k);
        n = 4000;
        % 激励覆盖整个 Q4.12 值域, 含深衰落时冲出星座的大幅度点
        x  = round((rand(n,1)*2-1)*20000) + 1j*round((rand(n,1)*2-1)*20000);
        sh  = randi([3 34], n, 1);
        man = randi([0 63], n, 1);
        cf  = sh*64 + man;

        Lq = double(rtl_mirror_demap(x, cf, [], m));

        wf   = (0.5 + man/128) .* 2.^(sh-30);           % conf 解回浮点权重
        Lref = mod_demapper_llr(x/4096, wf, m, 1) * K;
        Qref = max(min(round(Lref*16), 511), -512);

        d = abs(Lq - Qref);
        bad = mean(d(:) > 1);
        fprintf('    %-6s K=%-3d 最大差 %.2f LSB, RMS %.3f, >1LSB %.3g%%\n', ...
                m, K, max(d(:)), sqrt(mean(d(:).^2)), 100*bad);
        if max(d(:)) > 1 || bad > 0
            fprintf('    [FAIL] %s 超出 Q(10,4) 量化地板\n', m); fails = fails + 1;
        end
    end

    %% ================= T2 擦除语义 (裁定④ 闭环) =================
    fprintf('\n  T2 擦除语义:\n');
    n  = 200;
    x  = round((rand(n,1)*2-1)*20000) + 1j*round((rand(n,1)*2-1)*20000);
    cf = randi([3 34], n, 1)*64 + randi([0 63], n, 1);
    er = false(n,1); er(1:3:end) = true;                % 权重照常给, 只拉 erasure
    L  = double(rtl_mirror_demap(x, cf, er, '16QAM'));
    L  = reshape(L, 4, n).';
    a_er = all(all(L(er, :) == 0));
    a_ok = any(L(~er, :) ~= 0, 'all');                  % 非擦除点不能也是全 0
    fprintf('    T2a erasure 点全 0 = %d; 非擦除点有非零 = %d\n', a_er, a_ok);
    if ~a_er || ~a_ok, fprintf('    [FAIL] T2a\n'); fails = fails + 1; end

    % T2b 双保险: 不给 erasure 旗, 仅靠 conf=0 (sh=0 -> sh'>=62) 也必须得 0。
    % RTL 若省掉显式擦除一路, 这条仍应成立 —— 锁住它, 免得省掉后无人察觉。
    L0 = double(rtl_mirror_demap(x, zeros(n,1), false(n,1), '16QAM'));
    b_ok = all(L0(:) == 0);
    fprintf('    T2b conf=0 且不拉 erasure, 数据通路自然得 0 = %d\n', b_ok);
    if ~b_ok, fprintf('    [FAIL] T2b\n'); fails = fails + 1; end

    %% ================= T3 饱和而非回绕 =================
    % 回绕会**变号**, 在译码器眼里是"高置信度的错误比特", 比截断恶劣得多。
    fprintf('\n  T3 饱和:\n');
    n  = 64;
    x  = repmat(32767 + 1j*(-32768), n, 1);             % 冲到 Q4.12 极限
    cf = repmat(34*64 + 63, n, 1);                      % 最大权重 -> sh' 最小 = 28
    L  = double(rtl_mirror_demap(x, cf, [], '64QAM'));
    hit_hi = any(L == 511); hit_lo = any(L == -512);
    inrange = all(L >= -512 & L <= 511);
    fprintf('    极值下 触顶 %d 触底 %d, 全部落在 [-512,511] = %d\n', hit_hi, hit_lo, inrange);
    if ~(hit_hi && hit_lo && inrange)
        fprintf('    [FAIL] T3 未饱和或已回绕\n'); fails = fails + 1;
    end

    %% ================= T4 电平表与轴归属 =================
    fprintf('\n  T4 电平表 (RTL ROM 内容) 与轴归属:\n');
    EXP_LEV = { round([-1 1]/sqrt(2)*4096), ...
                round([-3 -1 1 3]/sqrt(10)*4096), ...
                round([-7 -5 -3 -1 1 3 5 7]/sqrt(42)*4096) };
    for k = 1:numel(MODS)
        m = MODS{k}; bps = BPS(k);
        [~, inf1] = rtl_mirror_demap(int32(0), 0, false, m);
        lv = inf1.levels;
        okl = isequal(lv, EXP_LEV{k}) && numel(lv) == 2^(bps/2);
        % 每个电平的标号必须互异, 否则该轴的比特分不出来
        oku = size(unique(inf1.labels_axis, 'rows'), 1) == numel(lv);
        fprintf('    %-6s 电平 %s 期望符合=%d 标号互异=%d\n', ...
                m, mat2str(lv), okl, oku);
        if ~okl || ~oku, fprintf('    [FAIL] T4 %s\n', m); fails = fails + 1; end
    end

    %% ================= T5 位宽上界与 sh' 值域 =================
    % RTL 照这两个数开位宽/开移位器。上界松了会溢出, sh' 上界估小了会漏掉
    % "|H|^2 极小 -> 超宽移位"那一支, 现象是深衰落载波给出乱数而不是 0。
    fprintf('\n  T5 位宽与 sh'' 值域:\n');
    d2max  = (32768 + 4424)^2;
    pmax   = d2max * 65024;
    w_d2   = ceil(log2(d2max)) + 1;
    w_prod = ceil(log2(pmax)) + 2;
    % 激励**必须含 conf=0 的擦除哨兵**: 首版只随机 sh in [3,34], 实测上界停在 59,
    % 于是"规格写 63"看着没问题。判卷向量的覆盖自查才撞出 sh'=66 —— 哨兵 sh=0。
    % 差别是实的: 移位量字段按 63 开只有 6 位, 66 会截断成 2, 深衰落载波于是给出
    % 满量程乱数而不是 0。这类"测出来的范围比真实范围窄"正是位宽错最爱藏的地方。
    okw = (w_d2 == 32) && (w_prod == 49);
    fprintf('    d2 -> u%d (期望 u32), metric*wman -> s%d (期望 s49) = %d\n', ...
            w_d2, w_prod, okw);
    if ~okw, fprintf('    [FAIL] T5 位宽\n'); fails = fails + 1; end

    n  = 500;
    x  = round((rand(n,1)*2-1)*32768) + 1j*round((rand(n,1)*2-1)*32768);
    gmax = 0;
    for k = 1:numel(MODS)
        m = MODS{k}; log2K = log2(KDEF(k));
        cf = randi([3 34], n, 1)*64 + randi([0 63], n, 1);
        cf(1) = 34*64 + 63;                           % 强制打到 sh 上界
        cf(2) = 0;                                    % 强制打到擦除哨兵 sh=0
        [~, inf5] = rtl_mirror_demap(x, cf, [], m);
        shr  = inf5.shift_range;
        want = [33 - log2K, 67 - log2K];              % sh' = 67 - sh - log2K
        oks  = isequal(shr, want);
        gmax = max(gmax, shr(2));
        fprintf('    %-6s sh'' 实测 [%d, %d], 解析 [%d, %d] = %d\n', ...
                m, shr(1), shr(2), want(1), want(2), oks);
        if ~oks, fprintf('    [FAIL] T5 %s sh'' 值域\n', m); fails = fails + 1; end
    end
    okf = (gmax == 66) && (ceil(log2(gmax + 1)) == 7);
    fprintf('    全档 sh'' 上界 %d -> 移位量字段 %d 位 (6 位不够) = %d\n', ...
            gmax, ceil(log2(gmax + 1)), okf);
    if ~okf, fprintf('    [FAIL] T5 移位量字段位宽\n'); fails = fails + 1; end

    %% ================= T6 输入契约 =================
    fprintf('\n  T6 输入契约 (必须报错而不是算出个数):\n');
    cases = { ...
        {'浮点符号而非 Q4.12 码值', @() rtl_mirror_demap(0.7+0.7j, 2048, false, 'QPSK')}, ...
        {'conf 超出 12 位',         @() rtl_mirror_demap(int32(100), 4096, false, 'QPSK')}, ...
        {'conf 为负',               @() rtl_mirror_demap(int32(100), -1, false, 'QPSK')}, ...
        {'BPSK 未定 K',             @() rtl_mirror_demap(int32(100), 2048, false, 'BPSK')}, ...
        {'K 非 2 的幂',             @() rtl_mirror_demap(int32(100), 2048, false, 'QPSK', 3)}, ...
        {'conf 与 x 不同形',        @() rtl_mirror_demap(int32([1 2]), 2048, [], 'QPSK')}};
    for c = 1:numel(cases)
        caught = false;
        try, cases{c}{2}(); catch, caught = true; end
        fprintf('    %-24s 报错=%d\n', cases{c}{1}, caught);
        if ~caught, fprintf('    [FAIL] T6 %s\n', cases{c}{1}); fails = fails + 1; end
    end

    %% ================= T7 标定自检 (可手算) =================
    % QPSK, K=2 (log2K=1)。电平 = round(±1/sqrt2·4096) = ±2896。
    % 取 y_I = +2896 (正落在 +电平上), 则 d2 = [(2896+2896)^2, 0] = [33547264, 0]。
    % QPSK 每轴 s=2b-1: 电平 -2896 标号 0, +2896 标号 1。
    %   metric = min(d2|b=1) - min(d2|b=0) = 0 - 33547264 = -33547264
    % 取 conf: sh=30, man=0 -> wman=32768, w=(32768/65536)·2^0=0.5
    %   sh' = 67-30-1 = 36
    %   llr = floor((-33547264·32768 + 2^35)/2^36) = floor(-15.4959...) = -16
    % 浮点侧核对: LLR = (0 - 1.99979)/2·0.5 = -0.49995, ×16×2 = -15.998 -> -16 ✓
    fprintf('\n  T7 标定自检 (手算闭式):\n');
    L7 = double(rtl_mirror_demap(complex(2896, -2896), 30*64 + 0, false, 'QPSK'));
    ok7 = isequal(L7(:).', [-16, 16]);                  % Q 轴取 -2896 -> 符号相反
    fprintf('    x=(+2896,-2896) conf={sh=30,man=0} -> %s, 期望 [-16 16] = %d\n', ...
            mat2str(L7(:).'), ok7);
    if ~ok7, fprintf('    [FAIL] T7\n'); fails = fails + 1; end

    %% =================
    fprintf('\n');
    if fails > 0
        error('test_rtl_mirror_demap:fail', 'rtl_mirror_demap: %d 条判据未过', fails);
    end
    ok = true;
end
