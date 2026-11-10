function demap_fp_proto()
%DEMAP_FP_PROTO  解调器整数数据通路原型 —— 定位宽与舍入点, 供镜像照抄
%
%   前面几轮已定: 按 I/Q 轴分解 (534b5b5) / K 按调制分档 / conf 12 位 / 符号约定。
%   还差两项**必须实测**的:
%     (a) metric 的中间位宽与截断点
%     (b) 权重相乘的舍入点 (先乘尾数后移位, 还是先移位后乘)
%   参照系与倒数 LUT 那次相同: **Q(10,4) 自身的量化地板**, 低于它就不必再追。
%
%   另有一项此前没显式提过、但 RTL 绕不开的: **电平表要量化到 Q4.12**。
%   星座电平是无理数 (16QAM 的 ±1/√10、±3/√10 等), 浮点锚用精确值, 而 RTL 只能
%   比对量化后的整数电平。这一步的误差要单独量出来, 不能混在别处。
%
%   拟定通路 (K 约束为 2 的幂 -> 乘 K 退化为移位, 与权重移位合并):
%     每轴  d2   = (y - lev)^2                       u31   (y,lev 均 Q4.12 整数)
%     逐比特 metric = min1 - min0                     s32
%     权重  wman = 2^15 + man*2^9                     u16   (M = wman/2^16)
%     末级  llr  = (metric*wman + half) >>> (67 - sh - log2K), 饱和到 10 位有符号
%           推导 (两处极易漏, 首版就漏了, 差出 2^25):
%             metric_int = metric_float · 2^24     <- d2 是 Q4.12 的**平方**
%             LLR_float  = metric_float / 2 · w    <- 锚里的 ÷(2σ²), σ²=1
%             w = (wman/2^16) · 2^(sh-30)
%             LLR_q104 = LLR_float · 16 · K
%                      = metric_int · wman / 2^(67 - sh - log2K)
%
%   用法: matlab -batch "addpath(<pkg>/analysis); demap_fp_proto"

    EA   = 'C:/Users/Lihan/.claude/engineering-assets';
    OFDM = fullfile(EA, 'models', 'comm', 'ofdm');
    addpath(fullfile(OFDM, 'src'));
    fprintf('  which(mod_demapper_llr) = %s\n\n', which('mod_demapper_llr'));

    rng(20260805);
    MODS = {'QPSK', '16QAM', '64QAM'};
    BPS  = [2 4 6];
    KSEL = [2 16 32];                      % 端到端 BER 实测的分档值, 均为 2 的幂

    fprintf('========================================\n');
    fprintf('  解调器整数通路原型 (定位宽与舍入点)\n');
    fprintf('========================================\n\n');

    fprintf('--- (a) 电平表量化到 Q4.12 的代价 ---\n');
    fprintf('%8s %10s %14s %14s\n', '调制', '电平数', '电平最大偏差', '折合 Q4.12 LSB');
    for k = 1:numel(MODS)
        [lev_f, lev_q] = levels(MODS{k});
        e = max(abs(lev_q/4096 - lev_f));
        fprintf('%8s %10d %14.3g %14.2f\n', MODS{k}, numel(lev_f), e, e*4096);
    end
    fprintf('\n');

    fprintf('--- (b) 整条整数通路 vs 浮点锚 (Q(10,4) 量化后逐点比对) ---\n');
    fprintf('判据: 与"浮点锚直接量化到 Q(10,4)"的差, 单位为 Q(10,4) 的 LSB (1/16)\n');
    fprintf('%8s %6s %12s %12s %12s\n', '调制', 'K', '最大差(LSB)', 'RMS(LSB)', '>1LSB 比例');
    for k = 1:numel(MODS)
        m = MODS{k}; bps = BPS(k); K = KSEL(k);
        n = 6000;
        % 激励覆盖整个 Q4.12 值域, 含深衰落时的大幅度点
        xr = round((rand(n,1)*2-1) * 20000);
        xi = round((rand(n,1)*2-1) * 20000);
        x  = xr + 1j*xi;
        sh  = randi([3 34], n, 1);
        man = randi([0 63], n, 1);
        wf  = (0.5 + man/128) .* 2.^(sh-30);        % 浮点权重

        Lref = mod_demapper_llr(x/4096, wf, m, 1) * K;
        Lref = reshape(Lref, bps, n).';
        Qref = sat10(round(Lref * 16));

        Qfp = fp_path(x, sh, man, m, K);

        d = abs(double(Qfp) - double(Qref));
        fprintf('%8s %6d %12.2f %12.3f %11.3g%%\n', m, K, max(d(:)), ...
                sqrt(mean(d(:).^2)), 100*mean(d(:) > 1));
    end
    fprintf('\n');

    fprintf('--- (c) 中间位宽的可证上界 ---\n');
    [~, lq] = levels('64QAM');
    ymax = 32768; lmax = max(abs(lq));
    d2max = (ymax + lmax)^2;
    fprintf('  d2   = (y-lev)^2 <= (%d+%d)^2 = %.4g  -> u%d\n', ymax, lmax, d2max, ceil(log2(d2max))+1);
    fprintf('  metric = min1-min0, |metric| <= d2max         -> s%d\n', ceil(log2(d2max))+2);
    fprintf('  wman <= 2^15 + 63*2^9 = %d                    -> u16\n', 2^15+63*2^9);
    fprintf('  metric*wman                                   -> s%d\n', ceil(log2(d2max))+2+16);
    fprintf('  末级右移量 = 67 - sh - log2K, sh∈[3,34], log2K∈{1,4,5} -> [%d, %d] 恒为右移\n', ...
            67-34-5, 67-3-1);
    fprintf('  注: 右移量可超过积的位宽 (最大 63 > 49) —— 那是 |H|² 极小时的正常情形,\n');
    fprintf('      结果趋于 0 即"该载波无可信信息", RTL 的移位器须能处理超宽移位。\n');
end

% =====================================================================
function [lev_f, lev_q] = levels(m)
%LEVELS  该调制每轴的 PAM 电平: 浮点精确值与 Q4.12 量化值
    switch upper(m)
        case 'QPSK',  raw = [-1 1];            sc = sqrt(2);
        case '16QAM', raw = [-3 -1 1 3];       sc = sqrt(10);
        case '64QAM', raw = [-7 -5 -3 -1 1 3 5 7]; sc = sqrt(42);
        otherwise, error('bad mod');
    end
    lev_f = raw(:) / sc;
    lev_q = round(lev_f * 4096);
end

function q = sat10(v)
    q = max(min(v, 511), -512);
end

function Q = fp_path(x, sh, man, m, K)
%FP_PATH  整条整数通路 (纯整数运算, RTL 照此实现)
    bps  = numel(dec2bin(0)) * 0; %#ok<NASGU>
    switch upper(m)
        case 'QPSK',  bps = 2; case '16QAM', bps = 4; case '64QAM', bps = 6;
    end
    half = bps/2;
    [~, lev] = levels(m);
    nlev = numel(lev);

    % 电平的比特标号: 由治理侧 mod_mapper 枚举得出, 不另写 Gray 表
    lab = zeros(nlev, half);
    M = 2^bps;
    for v = 0:M-1
        b = double(bitget(v, bps:-1:1)).';
        s = mod_mapper(b(:), m);
        li = find(abs(round(real(s)*4096) - lev) == 0, 1);
        if ~isempty(li), lab(li,:) = b(1:half).'; end
    end

    n = numel(x);
    log2K = round(log2(K));
    wman  = 2^15 + man*2^9;
    Q = zeros(n, bps);
    for ax = 1:2
        y = (ax==1) .* real(x) + (ax==2) .* imag(x);
        d2 = (y - lev.').^2;                          % [n x nlev], 整数
        for bi = 1:half
            is1  = lab(:,bi) == 1;
            metric = min(d2(:,is1), [], 2) - min(d2(:,~is1), [], 2);
            shift  = 67 - sh - log2K;
            prod   = metric .* wman;
            half_v = 2.^(shift-1);
            Q(:, (ax-1)*half+bi) = sat10(floor((prod + half_v) ./ 2.^shift));
        end
    end
end
