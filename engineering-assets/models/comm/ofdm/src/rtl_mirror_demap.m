function [llr_q104, info] = rtl_mirror_demap(x_q412, conf, erasure, mod_type, k_scale)
%RTL_MIRROR_DEMAP  mod_demapper 的定点位真镜像 —— 解调器 RTL 的需求侧单一事实源
%
%   [llr_q104, info] = rtl_mirror_demap(x_q412, conf, erasure, mod_type, k_scale)
%
%   与 rtl_mirror_eq / rtl_mirror_fft64 同一立场: **本函数按需求侧规格实现, 写它的
%   时候解调器还没有 RTL**。cosim 失配时修 RTL, 不改本镜像。
%
%   本文件的每个常数都有实测出处, 没有一个是"看着合理"定的:
%
%     结构  按 I/Q 两轴分解, 每轴 sqrt(M) 个电平   demap_axis_check.m
%           —— 前提"比特标号也按轴划分"是**查出来的**, 不是假定的; 三种调制的轴
%              归属实测为 [I..I, Q..Q], 分解式对锚偏差 2.66e-15
%     标度  K = 2 / 16 / 32 (QPSK/16QAM/64QAM)     demap_e2e_ber.m
%           —— 判据是**端到端 BER**, 不是量化率之类的代理指标 (代理指标定不了)
%     权重  w = |H|^2, 6 位尾数 + 6 位指数         demap_fixed_point_study.m
%     通路  位宽/舍入点/饱和点                     demap_fp_proto.m
%           —— 整数通路对浮点锚最大差 1.00 LSB, 超 1 LSB 的点 0%, 即 Q(10,4) 地板
%     符号  正 LLR = 该比特更可能是 0              mod_demapper_llr.m (裁定⑥)
%
%   ## 符号约定 (与 mod_demapper_llr 一致, 搞错会整体失效)
%
%   下游是 cbb/ldpc_codec, 其约定为 s = 1-2c, 故 **正 LLR 表示该比特更可能是 0**,
%   与 mod_mapper 的 s = 2b-1 方向相反。本镜像沿用 mod_demapper_llr 的号, 不再翻。
%
%   ## 与 mod_demapper_llr 的分工
%
%   mod_demapper_llr 是**浮点正确性锚** (穷举整星座, 数学上无近似);
%   本函数是**定点位真规格** (按轴分解 + 整数通路)。测试同时锁两者:
%   本函数 vs 锚的差必须落在 Q(10,4) 的量化地板内 —— 超出即为规格错, 不是"精度问题"。
%
%   ## 数值链 (RTL 必须逐位相同)
%
%     0. erasure -> 该载波 bps 个 LLR 全 0 (裁定④ 的擦除语义在此闭环)
%        注: 即便不显式判 erasure, conf=0 使 sh' >= 62 也自然得 0 —— 双保险,
%            测试 T2b 锁住这一点, 免得 RTL 省掉一路后无人察觉。
%     1. 解 conf: sh = conf[11:6] (6 位), man = conf[5:0] (6 位)
%        w = (wman/2^16) * 2^(sh-30),  wman = 2^15 + man*2^9   u16, <= 65024
%     2. 每轴 (I, Q) 独立, 各 sqrt(M) 个电平 lev (Q4.12 整数, 见 info.levels):
%        d2 = (y - lev)^2                          u32, <= (32768+4424)^2 = 1.383e9
%     3. 逐比特 metric = min(d2 | 该位=1) - min(d2 | 该位=0)    s33
%     4. llr = (metric * wman + 2^(sh'-1)) >>> sh',  sh' = 67 - sh - log2(K)
%        中间积 s49; 舍入为**加半再算术右移** (round-half-up)
%     5. 饱和到 10 位有符号 [-512, 511] —— 必须饱和, 不得回绕
%
%   常数 **67** 有两处极易漏 (首版就漏了, 差出 2^25, 现象是 LLR 全饱和):
%     metric_int = metric_float * 2^24     <- d2 是 Q4.12 的**平方**, 不是 Q4.12
%     LLR_float  = metric_float / 2 * w    <- 锚里的 /(2*sigma2), sigma2=1 时仍有 /2
%     LLR_q104   = LLR_float * 16 * K = metric_int * wman / 2^(67 - sh - log2K)
%
%   sh' = 67 - sh - log2K。**值域要连哨兵一起算, 且逐调制不同**:
%
%     sh 合法区 [3,34], 另加 conf=0 的擦除哨兵 sh=0 -> sh' in [33-log2K, 67-log2K]
%       QPSK  (log2K=1)  [32, 66]
%       16QAM (log2K=4)  [29, 63]
%       64QAM (log2K=5)  [28, 62]
%     全档上界 **66** -> RTL 的移位量字段要 **7 位**, 6 位不够。
%
%   这个 66 是判卷向量的覆盖自查撞出来的: 只随机 sh in [3,34] 时实测停在 59,
%   "规格写 63"看着毫无问题。按 63 (6 位) 开会把 66 截成 2, 于是深衰落载波给出
%   满量程乱数而不是 0 —— 那是译码器眼中"高置信度的错误比特", 比不输出恶劣得多。
%
%   **sh' 可超过积的位宽** (66 > 49) —— 那是 |H|^2 极小时的正常情形, 结果趋于 0
%   即"该载波无可信信息", 移位器须能处理超宽移位而不是回绕。
%
%   输入:
%     x_q412  - [N_data x N_sym] 复数, **实部虚部必须是整数** (Q4.12 码值);
%               来自 eq_zf 的 m_axis_tdata
%     conf    - 同形, 0..4095 整数; 来自 eq_zf 1.1.0 的 o_conf
%     erasure - 同形 logical; 来自 eq_zf 的 o_erasure。[] 则取 conf==0
%     mod_type- 'QPSK' | '16QAM' | '64QAM' (BPSK 见下方说明)
%     k_scale - 可选, 覆盖 K 的分档默认值 (**必须是 2 的幂**), 仅供扫描研究用
%   输出:
%     llr_q104- [N_data*bps x N_sym] int16, 值域 [-512, 511], Q(10,4) 码值
%               (真实 LLR = llr_q104 / 16 / K); 每符号 bps 个, b0 在前,
%               与 mod_demapper_llr 同形同序, 便于逐点对锚
%     info    - .k_scale K 实际取值       .levels  该调制每轴电平 (Q4.12, RTL ROM)
%               .labels_axis 电平的比特标号  .sat_count 饱和点数
%               .shift_range sh' 的实际取值范围   .spec 各级格式的文字说明
%
%   **BPSK 不在本镜像范围内**: 端到端 BER 只测了 QPSK/16QAM/64QAM 三档 K, BPSK 的 K
%   没有实测值。宁可在这里报错, 也不凭"BPSK 大概和 QPSK 差不多"填一个数进规格 ——
%   规格里的数字一旦落地, RTL 会照抄, 而错的标度在链路上只表现为"BER 略差"。

    if nargin < 5, k_scale = []; end
    if nargin < 4 || isempty(mod_type)
        error('rtl_mirror_demap:arg', 'mod_type 必填');
    end
    if nargin < 3, erasure = []; end

    if strcmpi(mod_type, 'BPSK')
        error('rtl_mirror_demap:bpsk', ...
              ['BPSK 未定标度 K —— demap_e2e_ber.m 只测了 QPSK/16QAM/64QAM。' ...
               '需先补端到端 BER 实测并经 owner 裁定, 不得沿用 QPSK 的 K。']);
    end

    bps  = bits_per_symbol(mod_type);
    half = bps / 2;                                   % 每轴的比特数

    validateattributes(x_q412, {'numeric'}, {'nonempty'}, mfilename, 'x_q412');
    if ~isequal(size(conf), size(x_q412))
        error('rtl_mirror_demap:dim', 'conf 须与 x_q412 同形, 实得 %s vs %s', ...
              mat2str(size(conf)), mat2str(size(x_q412)));
    end
    xr = double(real(x_q412));
    xi = double(imag(x_q412));
    if any(xr(:) ~= round(xr(:))) || any(xi(:) ~= round(xi(:)))
        error('rtl_mirror_demap:int', 'x_q412 须为 Q4.12 **整数码值**, 不是浮点符号');
    end
    cf = double(conf);
    if any(cf(:) ~= round(cf(:))) || any(cf(:) < 0) || any(cf(:) > 4095)
        error('rtl_mirror_demap:conf', 'conf 须为 [0,4095] 的整数 (12 位)');
    end
    if isempty(erasure)
        er = (cf == 0);
    else
        if ~isequal(size(erasure), size(x_q412))
            error('rtl_mirror_demap:dim', 'erasure 须与 x_q412 同形或为 []');
        end
        er = logical(erasure);
    end

    %% --- 标度 K: 端到端 BER 实测的分档值 ---
    if isempty(k_scale)
        K = default_k(mod_type);
    else
        K = double(k_scale);
    end
    log2K = log2(K);
    if K <= 0 || log2K ~= round(log2K)
        error('rtl_mirror_demap:k', 'K 须为 2 的幂 (乘 K 要退化为移位), 实得 %g', K);
    end

    %% --- 电平表与比特标号: 枚举治理侧 mod_mapper 得出, 不另写 Gray 表 ---
    [lev, labels_axis] = axis_levels(mod_type, bps, half);

    %% --- 解 conf ---
    sh   = floor(cf / 64);                            % conf[11:6]
    man  = cf - sh * 64;                              % conf[5:0]
    wman = 2^15 + man * 2^9;                          % u16, <= 65024
    shp  = 67 - sh - log2K;                           % sh', 恒为右移

    %% --- 逐轴逐比特 ---
    [nd, nsym] = size(x_q412);
    llr_col = zeros(nd * nsym, bps);
    wman_v  = wman(:);
    shp_v   = shp(:);
    er_v    = er(:);
    axis_y  = {xr(:), xi(:)};

    for ax = 1:2
        y  = axis_y{ax};
        d2 = (y - lev(:).').^2;                       % [n x nlev], 整数, u32
        for bi = 1:half
            is1    = labels_axis(:, bi) == 1;
            metric = min(d2(:, is1), [], 2) - min(d2(:, ~is1), [], 2);   % s33
            llr_col(:, (ax - 1) * half + bi) = ...
                shift_round_sat(metric .* wman_v, shp_v);
        end
    end
    llr_col(er_v, :) = 0;                             % 擦除: 全 0 = 最大不确定

    %% --- 展平成 [nd*bps x nsym], b0 在前 (与 mod_demapper_llr 同形同序) ---
    llr_q104 = int16(reshape(llr_col.', bps * nd, nsym));

    info = struct( ...
        'k_scale',     K, ...
        'levels',      lev(:).', ...
        'labels_axis', labels_axis, ...
        'n_erasure',   sum(er(:)), ...
        'sat_count',   sum(double(llr_q104(:)) >= 511 | double(llr_q104(:)) <= -512), ...
        'shift_range', [min(shp(:)), max(shp(:))], ...
        'spec',        sprintf(['d2 u32 | metric s33 | wman u16 (<=65024) | ' ...
                                'metric*wman s49 | >>> (67-sh-log2(%d)) | sat10'], K));
end

% =====================================================================
function q = shift_round_sat(p, s)
%SHIFT_ROUND_SAT  q = sat10( (p + 2^(s-1)) >>> s ) —— 加半再算术右移, 逐元素 s
%
%   为什么要分两支: |p| <= 1.383e9 * 65024 = 8.99e13 < 2^46.4。当 s >= 48 时
%   |p| < 2^(s-1), 结果**可证恒为 0**, 直接给 0; 而 s < 48 时 p + 2^(s-1) < 2^48,
%   double 可精确表示, floor 即算术右移。若走通用路径, s 最大 66 会让
%   p + 2^65 在 double 里丢掉低位 —— 那是**镜像自己失真**, 不是 RTL 的行为。
%   (同一类错误在 tb_demap_scale 的参考模型上实际发生过: 64 位半量溢出成负数。)

    PMAX = (32768 + 4424)^2 * 65024;                  % 可证上界, 见文件头
    if any(abs(p) > PMAX)
        error('rtl_mirror_demap:width', ...
              '中间积超出可证上界 %.4g (实得 %.4g) —— 位宽推导需重做', ...
              PMAX, max(abs(p)));
    end

    q    = zeros(size(p));
    big  = s >= 48;                                   % |p| < 2^(s-1), 结果恒 0
    n    = ~big;
    q(n) = floor((p(n) + 2.^(s(n) - 1)) ./ 2.^s(n));
    q    = max(min(q, 511), -512);
end

% =====================================================================
function [lev, labels_axis] = axis_levels(mod_type, bps, half)
%AXIS_LEVELS  该调制每轴的 Q4.12 电平与其比特标号
%
%   星座与标号**全部枚举治理侧 mod_mapper 得出**。qam_gray_map 的映射一旦变动,
%   本函数自动跟随, 不会出现"两处各写一份 Gray 表, 改了一处"的漂移。
%   同时在此处再验一遍"比特标号按轴划分" —— demap_axis_check.m 证过一次,
%   但那是分析脚本; 规格自己也要能立即发现前提被破坏, 而不是算出错的 LLR。

    M = 2^bps;
    I = zeros(M, 1); Q = zeros(M, 1); L = zeros(M, bps);
    for v = 0:M-1
        b = double(bitget(v, bps:-1:1)).';
        s = mod_mapper(b(:), mod_type);
        I(v+1) = real(s); Q(v+1) = imag(s); L(v+1, :) = b.';
    end

    % 前 half 位只影响 I, 后 half 位只影响 Q —— 破坏则不能按轴做
    for bi = 1:bps
        dI = false; dQ = false;
        for v = 0:M-1
            w = bitxor(v, bitshift(1, bps - bi));
            if abs(I(v+1) - I(w+1)) > 1e-12, dI = true; end
            if abs(Q(v+1) - Q(w+1)) > 1e-12, dQ = true; end
        end
        want_i = (bi <= half);
        if (dI && dQ) || (want_i && ~dI) || (~want_i && ~dQ)
            error('rtl_mirror_demap:axis', ...
                  ['%s 第 %d 位不再单属一轴 —— mod_mapper 的映射变了, ' ...
                   '按轴分解的前提被破坏, RTL 不能再按轴做'], mod_type, bi);
        end
    end

    lev_f = unique(round(I * 1e9) / 1e9);
    lev   = round(lev_f(:) * 4096);                   % Q4.12 整数电平, RTL ROM 内容
    if numel(unique(lev)) ~= numel(lev)
        error('rtl_mirror_demap:levq', '电平量化到 Q4.12 后出现重合 —— 星座分辨不出');
    end

    labels_axis = zeros(numel(lev), half);
    for li = 1:numel(lev)
        idx = find(abs(I - lev_f(li)) < 1e-9, 1);
        labels_axis(li, :) = L(idx, 1:half);
    end
end

% =====================================================================
function K = default_k(mod_type)
%DEFAULT_K  端到端 BER 实测的分档标度 (demap_e2e_ber.m)
%
%   代价高度不对称: 低阶用大 K 只是略差 (QPSK 取 32 -> BER 1.6 倍), 高阶用小 K 是
%   灾难性的 (64QAM 取 2 -> BER 由 3.09e-05 到 0.0902, 约 3000 倍)。故必须分档。

    switch upper(mod_type)
        case 'QPSK',  K = 2;
        case '16QAM', K = 16;
        case '64QAM', K = 32;
        otherwise, error('rtl_mirror_demap:mod', '不支持的调制方式: %s', mod_type);
    end
end

% =====================================================================
function bps = bits_per_symbol(mod_type)
    switch upper(mod_type)
        case 'QPSK',  bps = 2;
        case '16QAM', bps = 4;
        case '64QAM', bps = 6;
        otherwise, error('rtl_mirror_demap:mod', '不支持的调制方式: %s', mod_type);
    end
end
