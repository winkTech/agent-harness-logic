function out = rtl_mirror_tx(tx_bits, mod_type, N_sym)
%RTL_MIRROR_TX  OFDM 发射链定点位真镜像 (整数运算, 0 容差判卷用)
%
%   out = rtl_mirror_tx(tx_bits, mod_type, N_sym)
%
%   本函数按**需求侧规格**实现, 不照抄 RTL:
%     - 星座电平/归一化      config.m + src/mod_mapper.m
%     - 子载波与导频映射      config.m (data_idx / pilot_idx / pilot_val)
%                             + src/subcarrier_map.m (极性逐符号交替, 首符号 +)
%     - IFFT 标定             src/ifft_chain.m: ifft(x)*sqrt(N) = sum X*U^{nk}/8
%     - IFFT 结构             ADR-004 决策1 (R2^2SDF)
%     - 缩放与舍入调度        knowledge/.../ofdm/fixed_point_report.md §2.2/§2.4
%     - CP                    src/add_cp.m
%
%   **偏离上述规格的是 RTL, 不是本文件。** cosim 失配时应修 RTL; 不得反过来
%   改本文件或规格去迁就实现 (ADR-004 阶段3 + 用户 2026-08-01 裁定)。
%
%   与浮点 golden 的分工: src/tx_chain.m 是普遍性参考 (浮点, 判算法对错);
%   本函数是设计特性镜像 (定点, 判实现位真)。两者不可互相替代。
%
%   输入:
%     tx_bits  - 比特流列向量, 长度 >= N_sym*48*nb, 消费顺序与 tx_chain 一致
%     mod_type - 'BPSK' | 'QPSK' | '16QAM' | '64QAM'
%     N_sym    - OFDM 符号数
%   输出 (结构体):
%     out.bit_groups - [N_sym*48 x 1] 每星座符号的比特组 (LSB 对齐), RTL 激励
%     out.freq_grid  - [64 x N_sym]   频域整数网格 (Q2.14), 失配定位用
%     out.samples    - [N_sym*80 x 1] 复整数, 时域 Q3.13 期望输出 (re=I, im=Q)
%
%   实测: 与 incubator/intake/ofdm_tx_top 0.3.0 的 cosim, 2560 样点 0 失配。

    nb = local_mod_bits(mod_type);
    if numel(tx_bits) < N_sym*48*nb
        error('rtl_mirror_tx:shortBits', '需要 %d 比特, 实得 %d', ...
              N_sym*48*nb, numel(tx_bits));
    end
    tx_bits = double(tx_bits(:));

    % ---- 1. 星座映射 (mod_mapper 电平 x 16384, Q2.14) ------------------
    n_pt = N_sym * 48;
    bit_groups = zeros(n_pt,1);
    sym_re = zeros(n_pt,1);
    sym_im = zeros(n_pt,1);
    for p = 1:n_pt
        b = tx_bits((p-1)*nb + (1:nb));          % b(1)=b0=码流首比特
        g = 0;
        for j = 1:nb, g = g + b(j)*2^(j-1); end  % b0 落 tdata[0]
        bit_groups(p) = g;
        [sym_re(p), sym_im(p)] = local_map_bits(b, mod_type);
    end

    % ---- 2. 子载波/导频映射 (subcarrier_map 契约) ----------------------
    dbin = local_data_bins();
    fre = zeros(64, N_sym);
    fim = zeros(64, N_sym);
    for s = 1:N_sym
        pol = 1; if mod(s-1,2) == 1, pol = -1; end   % 首符号 +, 逐符号交替
        fre(7 +1, s) =  pol*16384;                   % pilot_idx +7,  val +1
        fre(21+1, s) = -pol*16384;                   % pilot_idx +21, val -1
        fre(43+1, s) =  pol*16384;                   % pilot_idx -21, val +1
        fre(57+1, s) =  pol*16384;                   % pilot_idx -7,  val +1
        for d = 1:48
            p = (s-1)*48 + d;
            fre(dbin(d)+1, s) = sym_re(p);
            fim(dbin(d)+1, s) = sym_im(p);
        end
    end

    % ---- 3. IFFT (R2^2SDF, 定点调度见 fixed_point_report §2.2) ---------
    % 尾部补 2 个全零符号: 排空流水的契约拍
    sr = [reshape(fre, [], 1); zeros(2*64,1)];
    si = [reshape(fim, [], 1); zeros(2*64,1)];
    [yr, yi] = local_sdf64_r22(sr, si);

    % 输出级: Q2.14 -> Q3.13 的格式转换 (x+1)>>>1, 再 s16 饱和
    yr = local_sat16(floor((yr + 1)/2));
    yi = local_sat16(floor((yi + 1)/2));

    if numel(yr) < N_sym*64
        error('rtl_mirror_tx:shortOut', 'IFFT 有效输出 %d < %d', ...
              numel(yr), N_sym*64);
    end

    % ---- 4. 位反序还原 + CP 插入 (add_cp 契约) -------------------------
    br = local_bitrev6();
    samples = zeros(N_sym*80, 1);
    for s = 1:N_sym
        b_re = yr((s-1)*64 + (1:64));
        b_im = yi((s-1)*64 + (1:64));
        nr = zeros(64,1); ni = zeros(64,1);
        for n = 0:63
            nr(br(n+1)+1) = b_re(n+1);           % 自然序位置 = bitrev(顺序号)
            ni(br(n+1)+1) = b_im(n+1);
        end
        ord = [49:64, 1:64];                     % CP = 尾部 16 点, 再本体 64 点
        samples((s-1)*80 + (1:80)) = nr(ord) + 1j*ni(ord);
    end

    out.bit_groups = bit_groups;
    out.freq_grid  = fre + 1j*fim;
    out.samples    = samples;
end

% ===================== 局部函数 =====================

function nb = local_mod_bits(mod_type)
    switch mod_type
        case 'BPSK',  nb = 1;
        case 'QPSK',  nb = 2;
        case '16QAM', nb = 4;
        case '64QAM', nb = 6;
        otherwise, error('rtl_mirror_tx: 不支持的调制方式: %s', mod_type);
    end
end

function [re, im] = local_map_bits(b, mod_type)
% 常数 = round(mod_mapper 归一化电平 * 16384):
%   BPSK  +-1               -> +-16384
%   QPSK  +-1/sqrt2         -> +-11585
%   16QAM {+-3,+-1}/sqrt10  -> {+-15543, +-5181}   (Gray: 00 01 11 10)
%   64QAM {+-7..+-1}/sqrt42 -> {+-17697,+-12641,+-2528,+-7584}
    P4 = [-15543, -5181, 15543, 5181];                     % 索引 {b0,b1}
    P8 = [-17697, -12641, -2528, -7584, ...                % 索引 {b0,b1,b2}
           17697,  12641,  2528,  7584];
    switch mod_type
        case 'BPSK'
            re = 16384*(2*b(1)-1);  im = 0;
        case 'QPSK'
            re = 11585*(2*b(1)-1);  im = 11585*(2*b(2)-1);
        case '16QAM'
            re = P4(b(1)*2 + b(2) + 1);
            im = P4(b(3)*2 + b(4) + 1);
        case '64QAM'
            re = P8(b(1)*4 + b(2)*2 + b(3) + 1);
            im = P8(b(4)*4 + b(5)*2 + b(6) + 1);
    end
end

function bins = local_data_bins()
% config.m: data_idx = setdiff([-26:-1 1:26], [-21 -7 7 21]) 升序 -> 自然 bin
    idx = setdiff([-26:-1, 1:26], [-21, -7, 7, 21]);
    bins = idx;
    bins(bins < 0) = bins(bins < 0) + 64;
end

function y = local_sat16(x)
    y = max(-32768, min(32767, x));
end

function br = local_bitrev6()
    br = zeros(64,1);
    for n = 0:63
        v = 0;
        for k = 0:5, v = v + bitget(n,k+1)*2^(5-k); end
        br(n+1) = v;
    end
end

function [xr, xi] = local_sdf64_r22(xr, xi)
%LOCAL_SDF64_R22  64 点 R2^2SDF (DIF, 共轭旋转因子 U = e^{+j2pi/64})
%
%   结构 (ADR-004 决策1): 奇数级 BF2I / 偶数级 BF2II, 延迟 32/16/8/4/2/1;
%   完整复乘仅 2 个 (级 2 与级 4 之后)。推导:
%     输入序 k=32k1+16k2+k3, 输出序 n=n1+2n2+4n3
%     U^{32k1 n} = (-1)^{k1 n1}          -> BF2I
%     U^{16k2 n} = j^{k2(n1+2n2)}        -> BF2II 的平凡因子, 乘在进入蝶形的 x 上
%                                          (故同时作用于和路与差路)
%     余项 U^{k3(n1+2n2)}                -> 级 2 后的完整复乘; 级 4 后降为 W_16=U^4
%   流式组号给出的是 (n2,n1), 故组系数需两位对调 P=[0 2 1 3]。
%
%   定点 (fixed_point_report §2.2/§2.4): 级 2/4/6 蝶形后 (x+1)>>>1 (rounding,
%   三级共 /8 达成 ifft(x)*sqrt(64) 标定); 旋转乘 (v*w + 8192)>>>14;
%   旋转因子 round(cos/sin(2pi k/64)*16384)。
%   注: Verilog 的 >>> 对负数为算术右移 = 向下取整, 故一律 floor 而非 fix。
    k   = (0:63)';
    TWC = round(cos(2*pi*k/64) * 16384);
    TWS = round(sin(2*pi*k/64) * 16384);
    P   = [0 2 1 3];

    for s = 1:6
        D     = bitshift(64, -s);
        BF2II = (mod(s,2) == 0);
        L     = numel(xr);
        fr = zeros(D,1); fi = zeros(D,1);         % 反馈 FIFO, fr(D) 为出口
        orr = zeros(L,1); oii = zeros(L,1);
        for n = 0:L-1
            c    = bitget(n, 6-s+1);              % 本级相位
            n1   = bitget(n, 7-s+1);              % 上一级半区 (平凡因子控制)
            fo_r = fr(D); fo_i = fi(D);
            x_r  = xr(n+1); x_i = xi(n+1);
            if c == 1
                if BF2II && n1 == 1               % 平凡因子 +j: (re,im)->(-im,re)
                    t = x_r; x_r = -x_i; x_i = t;
                end
                o_r = fo_r + x_r;  o_i = fo_i + x_i;   % 和 (n2=0)
                p_r = fo_r - x_r;  p_i = fo_i - x_i;   % 差 (n2=1), 存回 FIFO
            else
                o_r = fo_r;  o_i = fo_i;               % 上一块的差值出队
                p_r = x_r;   p_i = x_i;                % 本块样点入队
            end
            fr = [p_r; fr(1:D-1)];
            fi = [p_i; fi(1:D-1)];
            if BF2II                                   % 级 2/4/6 缩放 (rounding)
                o_r = floor((o_r + 1)/2);  o_i = floor((o_i + 1)/2);
            end
            orr(n+1) = o_r;  oii(n+1) = o_i;
        end
        orr = orr(D+1:end);  oii = oii(D+1:end);       % 丢弃本级填充期

        if s == 2 || s == 4                            % 完整复乘
            for m = 0:numel(orr)-1
                if s == 2
                    e = bitand(m,15) * P(bitand(bitshift(m,-4),3) + 1);
                else
                    e = 4 * bitand(m,3) * P(bitand(bitshift(m,-2),3) + 1);
                end
                wc = TWC(e+1);  ws = TWS(e+1);
                a = orr(m+1);   b = oii(m+1);
                orr(m+1) = floor((a*wc - b*ws + 8192)/16384);
                oii(m+1) = floor((a*ws + b*wc + 8192)/16384);
            end
        end
        xr = orr;  xi = oii;
    end
end
