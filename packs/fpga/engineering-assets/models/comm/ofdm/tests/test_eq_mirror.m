function pass = test_eq_mirror()
%% rtl_mirror_eq 测试: eq_zf 的定点位真镜像
%  被测对象同时是均衡器 RTL 的**需求侧单一事实源** —— 归一化移位、查表地址与内容、
%  Newton 的三步整数写法、末级定标舍入与饱和点, 此前全无单一事实源, 由该镜像钉死。
%  所以它自己得有治理级判据兜住。
%
%  判据要么解析可知, 要么有闭式期望值; 不读外部向量, 也不读 RTL 输出 —— 本镜像写在
%  RTL 之前, 现在也确实还没有 eq_zf 的 RTL, 不存在被 RTL 带偏的可能。

    config;
    N = cfg.N;
    rng(20260805);

    n_data = numel(cfg.data_idx);
    errors = 0;

    % 数据子载波的 MATLAB 下标 (与 rx_chain/eq_zf 同一换算, 本测试独立算一遍)
    bins = zeros(1, n_data);
    for d = 1:n_data
        idx = cfg.data_idx(d);
        if idx < 0, bins(d) = N + idx; else, bins(d) = idx; end
    end
    bml = bins + 1;

    %% --- T1. 标定: H=1, Y=1 -> Q4.12 的 1.0 ---
    % 这是整条定标链 (归一化 -> 查表 -> Newton -> sh=33-s 移位) 的锚点。
    Y1 = zeros(N, 1); H1 = zeros(N, 1);
    Y1(bml) = 16384;  H1(bml) = 16384;          % Q2.14 的 1.0
    [x1, er1, info1] = rtl_mirror_eq(Y1, H1, cfg);
    t1_val = all(real(x1(:)) == 4096) && all(imag(x1(:)) == 0);
    t1_er  = ~any(er1(:));
    if ~(t1_val && t1_er), errors = errors + 1; end
    fprintf('  [T1] 标定 H=1,Y=1 -> 4096+0i: 逐点 %d | 无误报 erasure %d\n', t1_val, t1_er);

    %% --- T1b. 取的 bin 必须与 eq_zf 完全相同 ---
    % 初版缺陷的回归防线: 镜像曾直接把 cfg.data_idx 当 1-based 用, 而 eq_zf 按有符号
    % 换算 —— 48 个载波里 6 个读错, 其中 2 个还落在 H 被置死 1.0 的未用载波上。
    % 约定一旦再漂, 这条立刻红。
    [~, infoF] = eq_zf(Y1 / 16384, H1 / 16384, cfg);
    t1b = isequal(sort(infoF.bins(:) + 1), sort(info1.bins(:)));
    if ~t1b, errors = errors + 1; end
    fprintf('  [T1b] bin 集合与 eq_zf 一致: %d\n', t1b);

    %% --- T2. 倒数表的结构性质 ---
    lut = info1.lut;
    t2 = numel(lut) == 256 && all(lut >= 0 & lut <= 65535) && all(diff(lut) <= 0);
    if ~t2, errors = errors + 1; end
    fprintf('  [T2] LUT: 256 项 %d | 全在 u16 %d | 单调不增 %d\n', ...
            numel(lut) == 256, all(lut >= 0 & lut <= 65535), all(diff(lut) <= 0));

    %% --- T3. 主判据: 对浮点 eq_zf 至少 2048 点, 偏差 < 2 个 Q4.12 LSB ---
    % 2048 点门限对齐 G-B-03。这里比的是"定点 vs 浮点", 允许的偏差只有量化与倒数
    % 近似两项; 若某处定标写错, 偏差会是**量级**上的, 不可能藏在 2 个 LSB 里。
    n_sym = 48;                                   % 48 x 48 = 2304 >= 2048
    Hc = zeros(N, n_sym); Yc = zeros(N, n_sym);
    hh = (randn(n_data,1) + 1j*randn(n_data,1)) / sqrt(2) * 0.7;
    hh(abs(hh) < 0.05) = 0.05;                    % 极深衰落单独在 T5 压
    hq = round(real(hh)*16384) + 1j*round(imag(hh)*16384);
    for c = 1:n_sym
        xx = (2*randi([0,1],n_data,1)-1 + 1j*(2*randi([0,1],n_data,1)-1)) / sqrt(2);
        yy = hh .* xx;
        Hc(bml, c) = hq;
        Yc(bml, c) = round(real(yy)*16384) + 1j*round(imag(yy)*16384);
    end
    [xm, ~, info3] = rtl_mirror_eq(Yc, Hc, cfg);
    xf   = eq_zf(Yc/16384, Hc/16384, cfg);
    lsb  = max(abs(xm/4096 - xf), [], 'all') * 4096;
    t3_n = numel(xm) >= 2048;
    t3_e = lsb < 2;
    if ~(t3_n && t3_e), errors = errors + 1; end
    fprintf('  [T3] 对浮点 eq_zf: %d 点 (>=2048: %d) | 最大偏差 %.2f LSB (<2: %d) | 饱和 %d\n', ...
            numel(xm), t3_n, lsb, t3_e, info3.sat_count);

    %% --- T4. 除零 (裁定④): 置零 + erasure, 且不得误伤邻居 ---
    H0 = Hc; H0(bml(3), 1) = 0;
    [x0, er0] = rtl_mirror_eq(Yc, H0, cfg);
    t4_hit   = er0(3,1) && x0(3,1) == 0;
    t4_clean = sum(er0(:)) == 1;                  % 只判精确零 -> 不能有阈值化副作用
    if ~(t4_hit && t4_clean), errors = errors + 1; end
    fprintf('  [T4] |H|^2=0: 置零+erasure %d | 其余载波零误报 %d\n', t4_hit, t4_clean);

    %% --- T5. 深衰落: 必须饱和, 不得回绕 ---
    % 回绕会让深衰落载波的错误无界, 是本件最需要防的失效模式。
    Hd = Hc; Hd(bml, 1) = 1 + 0j;                 % |H| = 1 个 LSB
    [xd, ~, info5] = rtl_mirror_eq(Yc, Hd, cfg);
    v = [real(xd(:,1)); imag(xd(:,1))];
    t5_range = all(v >= -32768 & v <= 32767);
    t5_hit   = info5.sat_count > 0;               % 确实走到了饱和路径
    if ~(t5_range && t5_hit), errors = errors + 1; end
    fprintf('  [T5] 深衰落 |H|=1LSB: 值域在 int16 内 %d | 饱和确实发生 %d (%d 点)\n', ...
            t5_range, t5_hit, info5.sat_count);

    %% --- T6. 归一化边界 s=-1: 闭式期望, 逐位相等 ---
    % Hre=Him=-32768 时 |H|^2 = 2^31, 是唯一让归一化移位取负的情形。
    % H=-2-2j, Y=1 -> X = 1*(-2+2j)/8 = -0.25+0.25j -> Q4.12 = -1024+1024i
    He = zeros(N,1); Ye = zeros(N,1);
    He(bml) = -32768 - 32768j;  Ye(bml) = 16384;
    [xe, ere] = rtl_mirror_eq(Ye, He, cfg);
    t6 = all(real(xe(:)) == -1024) && all(imag(xe(:)) == 1024) && ~any(ere(:));
    if ~t6, errors = errors + 1; end
    fprintf('  [T6] s=-1 边界 (H=-2-2j): 逐位等于 -1024+1024i %d\n', t6);

    %% --- T7. 入参防呆: 浮点真实值必须被拒 ---
    % 镜像吃的是**原始码值**; 误传真实值是最容易犯的错, 且不报错就会静默出垃圾。
    % 激励必须**真的**带小数才检验得到防呆。首版用 Y1/16384 是无效激励:
    % Y1 的取值只有 16384 与 0, 除完是 1 与 0, 全是整数, 判据永远不触发。
    t7 = false;
    try
        rtl_mirror_eq(Yc/16384, Hc/16384, cfg);
    catch ME
        t7 = strcmp(ME.identifier, 'rtl_mirror_eq:raw');
    end
    if ~t7, errors = errors + 1; end
    fprintf('  [T7] 误传浮点真实值必须报错: %d\n', t7);

    pass = (errors == 0);
end
