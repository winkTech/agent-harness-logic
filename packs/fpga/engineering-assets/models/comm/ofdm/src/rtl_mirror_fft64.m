function out = rtl_mirror_fft64(x_int, dir, out_order, P_W)
%RTL_MIRROR_FFT64  fft64_sdf 定点位真镜像 (整数运算, 0 容差判卷用)
%
%   out = rtl_mirror_fft64(x_int, dir, out_order, P_W)
%
%   本函数按**需求侧规格**实现, 不照抄 RTL:
%     - 结构        R2²SDF DIF, 6 级反馈延迟 32/16/8/4/2/1, 奇数级 BF2I /
%                   偶数级 BF2II, 完整复乘 2 个 (级 2 与级 4 之后)  [ADR-004]
%     - 标定        ifft(x)*sqrt(64) 与 fft(x)/sqrt(64) 同为 sum(...)/8,
%                   故两方向共用同一逐级移位调度            [src/ifft_chain.m,
%                                                            src/fft_chain.m]
%     - 缩放/舍入   级 2/4/6 后 (x+1)>>>1; 旋转乘 (v*w+8192)>>>14; 全部 rounding
%                                    [knowledge/.../ofdm/fixed_point_report.md §2.2/§2.4]
%     - 内部位宽    P_W (fft64_sdf = 21; 传 20 可复现既有 ifft64_sdf 的行为)
%                                    [需求门禁 2026-08-03 裁定, D5]
%
%   **偏离上述规格的是 RTL, 不是本文件。** cosim 失配时应修 RTL; 不得反过来改
%   本文件或规格去迁就实现 (与 rtl_mirror_tx 同一立场)。
%
%   为什么 P_W 从 20 加宽到 21: s20 在**满幅**输入下会回绕 —— 级 6 移位前
%   逐轴上界 = 64 项和 / 4 = 16*max|x| = 45.25 (Q2.14 两轴同时满幅时的模),
%   超出 s20 的 ±32; 实测对抗构造达 40.71, 满幅单音/直流恰好 31.999 (零裕量)。
%   s21 的 ±64 覆盖可证上界 45.25, 裕量 1.41x。真实 OFDM 信号峰值仅 3.6~4.7,
%   两种位宽都安全 —— 加宽针对的是强窄带干扰等满幅工况。
%
%   输入:
%     x_int     - [64 x N_sym] 复整数, Q2.14 (re=I, im=Q); 每列一个符号, 自然序
%     dir       - 'fft' (正向, 旋转因子 e^{-j}) | 'ifft' (反向, e^{+j})
%     out_order - 'natural' | 'bitrev'  (RTL 的 P_OUT_ORDER)
%     P_W       - 内部位宽 (默认 21)
%   输出 (结构体):
%     out.samples    - [64 x N_sym] 复整数; 格式随 dir:
%                      fft  → Q2.14 (输出级只饱和, 不移位)
%                      ifft → Q3.13 (输出级 (x+1)>>>1 + 饱和, 纯格式转换)
%     out.stage_peak - [1 x 6] 各级**移位前**逐轴峰值 (整数), 溢出复核用
%     out.overflow   - 内部超出 P_W 可表示范围的次数 (应恒为 0)
%     out.saturated  - 输出级饱和次数 (满幅病态输入下可非 0, 属预期)

    if nargin < 4 || isempty(P_W), P_W = 21; end
    if nargin < 3 || isempty(out_order), out_order = 'natural'; end
    N = 64; FRAC = 14; ONE = 2^FRAC;

    switch lower(dir)
        case 'fft',  dsign = -1;
        case 'ifft', dsign = +1;
        otherwise,   error('rtl_mirror_fft64:dir', "dir 须为 'fft' 或 'ifft'");
    end
    if size(x_int,1) ~= N
        error('rtl_mirror_fft64:dim', 'x_int 须为 [64 x N_sym], 实得 %d 行', size(x_int,1));
    end

    % 旋转因子表: round(cos/sin(2*pi*k/64)*16384), 正向取 sin 的负值
    k = (0:N-1).';
    TWC = round(cos(2*pi*k/N)*ONE);
    TWS = dsign * round(sin(2*pi*k/N)*ONE);

    N_sym = size(x_int,2);
    stream = x_int(:);                       % 逐拍流, 自然序, 每符号连续 64 拍
    % 尾部冲刷: 排空在途样点 (与 RTL 的 TB 契约一致)。
    % 总延迟 = 各级 FIFO 深度和 (32+16+8+4+2+1=63) + 两个复乘各 3 拍 = 69,
    % 故冲刷须 >69 拍; 取 2N=128 留余量。
    stream = [stream; zeros(2*N, 1)];

    peak = zeros(1,6);  ovf = 0;

    % 链路: 0 -st1- 1 -st2- 2 -mul0- 3 -st3- 4 -st4- 5 -mul1- 6 -st5- 7 -st6- 8
    %
    % 级间必须剥掉 warm-up: RTL 里每级的 r_cnt 只在 `i_beat && w_v[SI]` 时才走,
    % 而前 D 拍 (r_warm=0) 输出无效。若把这 D 拍也喂给下一级, 下一级计数器相位
    % 就错了 —— 旋转指数 e 由计数器导出, 相位一错则全错。故每级后丢弃前 D 个输出。
    % 复乘不需剥: 其 r_cnt 同样从首个有效输入起算, 而本模型的 y(t) 已对应 x(t)
    % (3 拍流水延迟不改变数值对应关系)。
    v = stream;
    for s = 1:6
        D = bitshift(N, -s);                 % 32,16,8,4,2,1
        [v, pk, o] = local_stage(v, D, mod(s,2)==0, P_W, dsign);
        peak(s) = pk;  ovf = ovf + o;
        v = v(D+1:end);                      % 丢弃 warm-up, 对齐下一级计数器
        if s == 2
            [v, o] = local_mult(v, 4, 1, TWC, TWS, ONE, P_W);  ovf = ovf + o;
        elseif s == 4
            [v, o] = local_mult(v, 2, 4, TWC, TWS, ONE, P_W);  ovf = ovf + o;
        end
    end

    % 输出级: ifft → (x+1)>>>1 转 Q3.13; fft → 保持 Q2.14。两者均 s16 饱和。
    y = v(1 : N*N_sym);
    if dsign > 0
        y = complex(floor((real(y)+1)/2), floor((imag(y)+1)/2));
    end
    [y, sat] = local_sat16(y);

    y = reshape(y, N, N_sym);
    if strcmpi(out_order, 'natural')
        y(local_bitrev6(0:N-1)+1, :) = y;    % 位反序 → 自然序
    end

    out = struct('samples', y, 'stage_peak', peak, 'overflow', ovf, 'saturated', sat);
end

% ── SDF 蝶形级 ────────────────────────────────────────────────────────────
function [y, peak, ovf] = local_stage(x, D, isBF2II, P_W, dsign)
    n = numel(x);  y = zeros(n,1);  fifo = zeros(D,1);
    LG = round(log2(D));  peak = 0;  ovf = 0;
    lim = 2^(P_W-1);
    for t = 1:n
        cnt = t-1;
        c  = bitget(cnt, LG+1);              % r_cnt[LG]
        n1 = bitget(cnt, LG+2);              % r_cnt[LG+1]
        xv = x(t);
        if isBF2II && c && n1
            % 平凡因子 j^{n1}: IFFT 用 +j, FFT 用其共轭 -j。
            % **两处符号都要随方向翻**: 非平凡旋转因子表 (TWS) 与此处。
            % 只翻前者会让正向输出错到比信号本身还大 (实测最大误差 46725 LSB
            % vs 信号幅度 17800 LSB); 两处都翻后降到 3.5 LSB 即真正的量化量级。
            if dsign > 0
                xv = 1i*xv;                  % (re,im) -> (-im, re)
            else
                xv = -1i*xv;                 % (re,im) -> ( im,-re)
            end
        end
        f = fifo(D);
        if c
            bout = f + xv;  pin = f - xv;
        else
            bout = f;       pin = xv;
        end
        fifo = [pin; fifo(1:D-1)];
        peak = max(peak, max(abs(real(bout)), abs(imag(bout))));   % 移位前
        if max(abs(real(bout)), abs(imag(bout))) >= lim, ovf = ovf + 1; end
        if isBF2II
            bout = complex(floor((real(bout)+1)/2), floor((imag(bout)+1)/2));
        end
        y(t) = bout;
    end
end

% ── 完整复乘 ──────────────────────────────────────────────────────────────
function [y, ovf] = local_mult(x, KLG, SCALE, TWC, TWS, ONE, P_W)
    n = numel(x);  y = zeros(n,1);  ovf = 0;  lim = 2^(P_W-1);
    for t = 1:n
        cnt  = t-1;
        base = mod(cnt, 2^KLG);
        grp  = mod(floor(cnt / 2^KLG), 4);
        sw   = bitget(grp,1)*2 + bitget(grp,2);      % {grp[0], grp[1]} 两位对调
        e    = mod(SCALE * base * sw, 64);
        wc = TWC(e+1);  ws = TWS(e+1);
        ar = real(x(t)); ai = imag(x(t));
        re = floor((ar*wc - ai*ws + ONE/2) / ONE);
        im = floor((ar*ws + ai*wc + ONE/2) / ONE);
        if max(abs(re), abs(im)) >= lim, ovf = ovf + 1; end
        y(t) = complex(re, im);
    end
end

function [y, sat] = local_sat16(x)
    hi = 2^15 - 1;  lo = -2^15;
    re = real(x); im = imag(x);
    sat = sum(re > hi | re < lo | im > hi | im < lo);
    re = min(max(re, lo), hi);  im = min(max(im, lo), hi);
    y = complex(re, im);
end

function r = local_bitrev6(n)
    r = zeros(size(n));
    for b = 0:5
        r = r + bitshift(bitget(n, b+1), 5-b);
    end
end
