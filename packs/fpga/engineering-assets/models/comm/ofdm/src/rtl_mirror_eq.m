function [x_q412, erasure, info] = rtl_mirror_eq(Y_q214, H_q214, cfg)
%RTL_MIRROR_EQ  eq_zf 的定点位真镜像 —— 均衡器 RTL 的需求侧单一事实源
%
%   [x_q412, erasure, info] = rtl_mirror_eq(Y_q214, H_q214, cfg)
%
%   本函数**按需求侧规格实现**, 不是照 RTL 写的 —— 写它的时候 eq_zf 还没有 RTL,
%   这是刻意选的时机。规格来自 2026-08-04/05 的四条 owner 裁定与
%   incubator/intake/eq_zf/analysis/fixed-point-study.md 的实测结论:
%
%     裁定①②③  X = Y·conj(H)·(1/|H|²), 共轭乘 + 实数倒数, 64->48 提取在件内
%     实测 D5(a) 倒数 = 8 位查表 + 一次 Newton (相对误差 3.80e-06 ≈ 0.06 LSB)
%     实测 D5(b) 输出 = Q4.12 + 显式饱和 (非截断回绕)
%     裁定④      |H|² == 0 -> 输出 0 且拉 erasure, 只判精确零, 无可配阈值
%
%   **偏离本镜像的是 RTL, cosim 失配时修 RTL 而非改本镜像** —— 与 rtl_mirror_tx /
%   rtl_mirror_fft64 同一立场。本文件同时定义了此前不存在单一事实源的那几件事:
%   归一化移位、查表的地址与内容格式、Newton 的整数写法、最终舍入与饱和点。
%
%   输入:
%     Y_q214 - [N x N_sym] 复数, **实部虚部必须是整数** (Q2.14 原始码值, 即
%              真实值 x 2^14); 来自 fft64_sdf 输出
%     H_q214 - [N x N_sym] 同上; 来自 channel_est_top 输出
%     cfg    - 用 cfg.N 与 cfg.data_idx
%   输出:
%     x_q412  - [N_data x N_sym] int16 值域的 Q4.12 原始码值 (真实值 x 2^12)
%     erasure - [N_data x N_sym] logical, 该载波因 |H|²=0 而无信息
%     info    - .lut        256 项倒数表 (RTL ROM 的内容就取这个)
%               .h2_raw     |H|² 原始码值 (Q4.28)
%               .sat_count  发生饱和的点数
%               .spec       各级位宽与格式的文字说明
%
%   数值链 (逐级格式, RTL 必须逐位相同):
%     1. h2_raw = Hre² + Him²                    u32, Q4.28   (最大 2^31)
%     2. h2_raw == 0 -> x=0, erasure=1, 结束
%     3. 归一化: norm = h2_raw << s ∈ [2^30, 2^31)   s ∈ [-1, 30]
%        (h2_raw 可取到 2^31 —— Hre=Him=-32768 时 —— 故 s 允许为 -1)
%     4. M16 = norm >> 15                        u16, ∈[2^15,2^16), M = M16/2^16 ∈ [0.5,1)
%        **截断而非舍入**: 舍入会把 M16 顶到 2^16 溢出
%     5. addr = (M16 >> 7) & 0xFF                8 位 (M16 的 bit14..bit7; bit15 恒为 1)
%        r0 = LUT[addr]                          u16, Q2.14, ≈ 1/M ∈ (1,2]
%     6. Newton 一次:
%        p  = (M16 * r0) >> 16                   u32 中间, 结果 Q2.14, ≈ 2^14
%        t  = 2^15 - p                           Q2.14 的 (2 - M·r0)
%        r1 = (r0 * t) >> 14                     u16, Q2.14, ≈ 1/M
%     7. num_re = Yre·Hre + Yim·Him              s33, Q4.28
%        num_im = Yim·Hre - Yre·Him              s33, Q4.28
%     8. x = (num * r1 + 2^(sh-1)) >> sh,  sh = 33 - s ∈ [3, 34]
%        中间积 s49; 舍入为**加半再算术右移** (round-half-up)
%     9. 饱和到 int16 [-32768, 32767] —— 必须饱和, 不得回绕
%
%   标定自检: H=1 (Hre=16384) 且 Y=1 时, 逐级得 s=2, M16=32768, addr=0,
%   r1=32767, sh=31, x = 2^28·32767/2^31 = 4095.875 -> 4096 = Q4.12 的 1.0。

    N = cfg.N;
    if size(Y_q214, 1) ~= N || size(H_q214, 1) ~= N
        error('rtl_mirror_eq:dim', 'Y/H 须为 [%d x N_sym], 实得 %d / %d 行', ...
              N, size(Y_q214, 1), size(H_q214, 1));
    end
    if size(Y_q214, 2) ~= size(H_q214, 2)
        error('rtl_mirror_eq:dim', 'Y 与 H 符号数不一致: %d vs %d', ...
              size(Y_q214, 2), size(H_q214, 2));
    end
    check_raw(Y_q214, 'Y_q214');
    check_raw(H_q214, 'H_q214');

    % 子载波下标换算**必须与 eq_zf 逐字相同** —— cfg.data_idx 是 802.11a 的有符号
    % 下标, 负数绕到 N+idx, 再 +1 成 MATLAB 下标 (自然序, 对应 fft64_sdf 的
    % P_NATURAL_OUT=1)。镜像若换一套约定, 它和被镜像的 golden 就不是在同一批载波上
    % 比对, 差异会被误读成量化误差。
    % 注意: models/comm/channel_est 用的是 **fftshift 序** (config.m 的 data_idx
    % 已 +33, lts_seq 亦然), 与此不同, 不可混用 —— 本文件初版就栽在这上面, 详见
    % incubator/intake/eq_zf/analysis/fixed-point-study.md §1.1。
    sgn  = cfg.data_idx(:);
    bins = sgn;
    bins(sgn < 0) = N + sgn(sgn < 0);
    bins = bins + 1;

    nsym = size(Y_q214, 2);
    nd   = numel(bins);

    Yre = real(Y_q214(bins, :));  Yim = imag(Y_q214(bins, :));
    Hre = real(H_q214(bins, :));  Him = imag(H_q214(bins, :));

    lut = recip_lut();

    x_q412   = zeros(nd, nsym);
    erasure  = false(nd, nsym);
    h2_raw   = Hre.^2 + Him.^2;                 % 步骤 1; double 精确 (<= 2^31 << 2^53)
    sat_cnt  = 0;
    % 逐载波可靠度侧带 (owner 裁定⑤, 2026-08-05): |H|² = M·2^(sh-30), M = M16/2^16。
    % 二者都是步骤 3/4 归一化时**已经算出来**的中间量, 这里只是导出, 不增加任何运算。
    % 下游解调器用它给 LLR 加权 —— ZF 归一化掉了幅度, 不带它则深衰落载波会以与强载波
    % 相同的置信度进译码器。位宽 (6 位尾数 + 6 位指数) 由端到端 BER 实测定, 见
    % incubator/intake/mod_demapper/analysis/fixed-point-study.md。
    m16_out  = zeros(nd, nsym);
    sh_out   = zeros(nd, nsym);

    for c = 1:nsym
        for k = 1:nd
            h2 = h2_raw(k, c);

            % --- 步骤 2: 裁定④ 只判精确零 -----------------------------------
            if h2 == 0
                x_q412(k, c) = 0;
                erasure(k, c) = true;
                continue;
            end

            % --- 步骤 3: 归一化到 [2^30, 2^31) ------------------------------
            s = 30 - floor(log2(h2));
            if s >= 0
                norm = h2 * 2^s;
            else
                norm = floor(h2 / 2^(-s));       % s = -1 的唯一情形: h2 = 2^31
            end

            % --- 步骤 4/5: 取 M16, 查表 -------------------------------------
            M16  = floor(norm / 2^15);           % 截断
            addr = mod(floor(M16 / 2^7), 256);
            r0   = lut(addr + 1);

            % --- 步骤 6: 一次 Newton ----------------------------------------
            p  = floor(M16 * r0 / 2^16);
            t  = 2^15 - p;
            r1 = floor(r0 * t / 2^14);

            % --- 步骤 7: 共轭乘 ---------------------------------------------
            num_re = Yre(k,c)*Hre(k,c) + Yim(k,c)*Him(k,c);
            num_im = Yim(k,c)*Hre(k,c) - Yre(k,c)*Him(k,c);

            % --- 步骤 8/9: 定标 + 舍入 + 饱和 -------------------------------
            sh = 33 - s;
            xr = shift_round(num_re * r1, sh);
            xi = shift_round(num_im * r1, sh);

            [xr, s1] = sat16(xr);
            [xi, s2] = sat16(xi);
            sat_cnt  = sat_cnt + s1 + s2;

            x_q412(k, c) = xr + 1j*xi;
            m16_out(k, c) = M16;                 % 可靠度侧带: 已算好的中间量, 只是导出
            sh_out(k, c)  = sh;
        end
    end

    info = struct();
    info.lut       = lut;
    info.h2_raw    = h2_raw;
    info.sat_count = sat_cnt;
    info.bins      = bins;
    % 逐载波可靠度 (裁定⑤): |H|² = (m16/2^16) · 2^(sh-30)。RTL 侧只取 m16 的高 6 位
    % (M16[14:9]) 与 6 位 sh 拼成 o_conf[11:0] —— 位宽由端到端 BER 实测定。
    % erasure 点 (h2==0) 的 m16/sh 保持 0: 那里没有可靠度可言, 下游按 LLR=0 处理。
    info.m16       = m16_out;
    info.sh        = sh_out;
    info.conf_spec = 'o_conf = {sh[5:0], m16[14:9]}; |H|² = (m16/2^16)·2^(sh-30)';
    info.spec      = [ ...
        'h2:u32/Q4.28 | norm∈[2^30,2^31), s∈[-1,30] | M16:u16 截断 | ' ...
        'LUT:256xu16/Q2.14 | Newton: p=(M16*r0)>>16, t=2^15-p, r1=(r0*t)>>14 | ' ...
        'num:s33/Q4.28 | x=(num*r1+2^(sh-1))>>sh, sh=33-s | 饱和 int16'];
end

% =====================================================================
function lut = recip_lut()
%RECIP_LUT  256 项倒数表 —— **RTL 的 ROM 内容就取这个数组, 不要另算一份**
%
%   地址 a (0..255) 覆盖 M ∈ [0.5 + a/512, 0.5 + (a+1)/512)。
%   表项取该区间**中点**的倒数 (中点比端点的最大误差小一半):
%       LUT[a] = round(2^14 / (0.5 + (a + 0.5)/512))
%   值域 [16400, 32704], 恰在 u16 内 —— 取中点还顺带避开了 M=0.5 处 1/M=2 需要
%   2^15 的边界情形。
    a  = (0:255).';
    Mc = 0.5 + (a + 0.5) / 512;
    lut = round(2^14 ./ Mc);
end

function y = shift_round(x, sh)
%SHIFT_ROUND  加半再算术右移 (round-half-up)。RTL 即 (x + (1<<(sh-1))) >>> sh。
    y = floor((x + 2^(sh-1)) / 2^sh);
end

function [y, hit] = sat16(x)
%SAT16  饱和到 int16 —— 必须饱和, 回绕会让深衰落载波的错误无界
    hit = 0;
    if x > 32767,  y = 32767;  hit = 1;
    elseif x < -32768, y = -32768; hit = 1;
    else, y = x;
    end
end

function check_raw(v, name)
    r = real(v); i = imag(v);
    if any(r(:) ~= floor(r(:))) || any(i(:) ~= floor(i(:)))
        error('rtl_mirror_eq:raw', ...
              '%s 的实部/虚部必须是整数原始码值 (真实值 x 2^14), 不是浮点真实值', name);
    end
    if any(abs(r(:)) > 32768) || any(abs(i(:)) > 32768)
        error('rtl_mirror_eq:range', '%s 超出 int16 值域', name);
    end
end
