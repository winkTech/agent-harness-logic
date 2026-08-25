function gen_eq_vectors()
%GEN_EQ_VECTORS  由 rtl_mirror_eq 导出 eq_zf 顶层的位真判卷向量
%
%   期望值来自**治理侧的定点镜像** (models/comm/ofdm/src/rtl_mirror_eq.m), 不是
%   浮点直接量化, 因此判据是 **0 容差** —— 镜像与 RTL 走同一条整数路径, 任何差异
%   都是缺陷而不是噪声。对应需求门禁 D3 判据(1) 与 G-B-03 (>=2048 点)。
%
%   激励刻意分类而非纯随机。纯随机在 Rayleigh 分布下几乎打不到边界, 而边界正是最
%   容易写错的地方:
%     符号 1..40   常规信道
%     符号 41      深衰落 (|H| 压到几个 LSB) —— 逼出饱和路径
%     符号 42      含 |H|²=0 的数据载波   —— 逼出 erasure (裁定④)
%     符号 43      H = -32768-32768j       —— s=-1, 唯一需右移的归一化边界
%     符号 44..48  满幅随机压力
%
%   **非数据载波 (导频/DC/保护带) 填对抗性垃圾值**: 若 RTL 的 64->48 选择写错、
%   误用了这些 bin, 输出会明显不对而不是"差一点"。
%
%   输出 (vectors/):
%     y.hex        (2+NSYM)*64 行, 32 位 {im, re} —— 含两个 LTS 符号
%     h.hex        NSYM*64 行 —— 只有数据符号有 H
%     x_exp.hex    NSYM*48 行, Q4.12 {im, re}
%     er_exp.hex   NSYM*48 行, 0/1
%     vec_config.txt
%
%   打包字序 **{im, re}** —— 与 cp_remove / channel_est_top 一致。本链路上
%   fft64_sdf 的判卷 TB 用的是 {re, im}, 本轮曾因此产生 2327/2560 的假失配。

    EA   = 'C:/Users/Lihan/.claude/engineering-assets';
    OFDM = fullfile(EA, 'models', 'comm', 'ofdm');
    % 输出目录由**本文件位置**推出, 不写死 —— 包从 incubator/intake/eq_zf 迁到
    % cbb/eq_zf 时写死的路径会把向量写回旧位置 (并把已删除的目录又建出来), 而 TB
    % 读的是新位置, 于是拿到的是**上一版**向量。这类错不报警, 只表现为判卷莫名失配。
    OUT  = fullfile(fileparts(fileparts(mfilename('fullpath'))), 'vectors');
    if ~exist(OUT, 'dir'), mkdir(OUT); end
    addpath(fullfile(OFDM, 'src'), OFDM);

    got = which('rtl_mirror_eq');
    fprintf('which(rtl_mirror_eq) = %s\n', got);
    assert(startsWith(got, strrep(fullfile(OFDM,'src'), '/', filesep)) || ...
           startsWith(strrep(got,'\','/'), [strrep(OFDM,'\','/') '/src']), ...
           'rtl_mirror_eq 未解析到治理资产');

    rng(20260805, 'twister');
    config;                                   % ofdm 侧 cfg (data_idx 为有符号自然序)
    N    = cfg.N;
    NSYM = 48;                                % 48 x 48 = 2304 点 >= 2048

    bml = cfg.data_idx; bml(bml < 0) = N + bml(bml < 0); bml = bml + 1;
    nd  = numel(bml);
    non = setdiff(1:N, bml);                  % 导频/DC/保护带

    %% ---- 构造 Y / H ------------------------------------------------------
    Y = zeros(N, NSYM);
    H = zeros(N, NSYM);

    for c = 1:NSYM
        % 常规信道: Rayleigh 后量化到 Q2.14
        hh = (randn(nd,1) + 1j*randn(nd,1)) / sqrt(2) * 0.7;
        hh(abs(hh) < 0.03) = 0.03;
        hq = q214(hh);
        xx = (2*randi([0,1],nd,1)-1 + 1j*(2*randi([0,1],nd,1)-1)) / sqrt(2);
        yq = q214(hh .* xx);

        switch c
            case 41                                    % 深衰落 -> 逼饱和
                hq = q214((randn(nd,1)+1j*randn(nd,1)) * 2e-4);
                hq(hq == 0) = 1;                       % 本符号不测除零, 留给 42
                yq = q214((randn(nd,1)+1j*randn(nd,1)) * 0.5);
            case 42                                    % 除零 -> 逼 erasure
                hq(1:7:end) = 0;
            case 43                                    % s = -1 归一化边界
                hq(:) = -32768 - 32768j;
                yq(:) = 16384;                          % 期望闭式 -1024+1024i
            case {44,45,46,47,48}                       % 满幅压力
                hq = q214((rand(nd,1)*4-2) + 1j*(rand(nd,1)*4-2));
                hq(hq == 0) = 1;
                yq = q214((rand(nd,1)*4-2) + 1j*(rand(nd,1)*4-2));
        end

        Y(bml, c) = yq;   H(bml, c) = hq;
        % 非数据载波: 对抗性垃圾 —— 误用它们会明显出错, 而不是"差一点"
        Y(non, c) = 32767 - 32767j;
        H(non, c) = 1 + 1j;                             % |H|² 极小 -> 误用则巨幅放大
    end

    %% ---- 期望值: 走治理侧镜像 -------------------------------------------
    [x_q412, erasure, info] = rtl_mirror_eq(Y, H, cfg);

    % **不做行序置换 —— 期望值就用镜像的原生行序 (cfg.data_idx 序)**。
    % 该序才是系统契约: rx_chain.m 第 3 步按 cfg.data_idx(d) 取 bin 再把 data_sym(:)
    % 喂给 mod_demapper, 发端 subcarrier_map 用同一个序放数据, 比特与子载波的对应
    % 关系由它定义。硬件顺着 fft64_sdf 的输出流只能按 bin 升序出, 两者恰差左旋 24,
    % 这一步转换由 RTL 侧的 eq_reorder 承担 (裁定③ 的同一理由: 下游期望什么就给什么)。
    % 早期版本曾在这里把期望值置换成升序去迁就 RTL —— 那是把接口缺口挪到下游, 不是解决。
    fprintf('镜像产出: %d x %d 点, 饱和 %d, erasure %d\n', ...
            size(x_q412,1), size(x_q412,2), info.sat_count, sum(erasure(:)));
    assert(numel(x_q412) >= 2048, '点数 %d 不足 2048', numel(x_q412));

    %% ---- LTS 两符号 (只进 Y, 不产 H/X) ----------------------------------
    Ylts = q214((randn(N,2) + 1j*randn(N,2)) * 0.5);

    %% ---- 写盘 -----------------------------------------------------------
    %% ---- 逐载波可靠度 o_conf = {sh[5:0], m16[14:9]} (裁定⑤) --------------
    % m16 的 bit15 恒为 1 (归一化保证), 故 floor(m16/2^9) 落在 64..127, mod 64 正好
    % 取出 bit14..9 这 6 位。位宽由端到端 BER 实测定, 见 mod_demapper 的定点报告。
    man  = mod(floor(info.m16 / 2^9), 64);
    conf = info.sh * 64 + man;

    % **重构判据** —— 这条不能省。RTL 照镜像写、向量也出自镜像, **同源的错互相验证
    % 不出来**; 只有这条独立的闭式关系能证伪 m16/sh 本身是否导出正确。
    % 只在非 erasure 点上查: h2==0 的点没有可靠度可言, m16/sh 保持 0。
    ok = ~erasure;
    h2 = info.h2_raw / 2^28;
    rec = (info.m16 / 2^16) .* 2.^(info.sh - 30);
    rel = abs(rec(ok) - h2(ok)) ./ h2(ok);
    if max(rel) >= 2^-15
        error('gen_eq_vectors:conf', ...
              '可靠度重构相对误差 %.4g 超出 M16 截断界 2^-15 —— 镜像的 m16/sh 导出有误', ...
              max(rel));
    end
    fprintf('可靠度重构校验通过: 最大相对误差 %.4g < 2^-15 = %.4g\n', max(rel), 2^-15);

    wr_iq(fullfile(OUT,'y.hex'),     [Ylts, Y]);        % 先 LTS1/LTS2 再数据符号
    wr_iq(fullfile(OUT,'h.hex'),     H);
    wr_iq(fullfile(OUT,'x_exp.hex'), x_q412);
    wr_bit(fullfile(OUT,'er_exp.hex'), erasure);
    wr_u16(fullfile(OUT,'conf_exp.hex'), conf);

    f = fopen(fullfile(OUT,'vec_config.txt'), 'w');
    fprintf(f, 'N %d\nNSYM %d\nNDATA %d\nNLTS 2\nPOINTS %d\n', N, NSYM, nd, numel(x_q412));
    fprintf(f, 'PACK {im,re}\nY_FMT Q2.14\nH_FMT Q2.14\nX_FMT Q4.12\n');
    fprintf(f, 'SOURCE rtl_mirror_eq.m (models/comm/ofdm/src) — 0 容差判卷\n');
    fprintf(f, 'SAT %d\nERASURE %d\n', info.sat_count, sum(erasure(:)));
    fclose(f);

    fprintf('已写入 %s\n', OUT);
end

% =====================================================================
function q = q214(x)
    s = 16384;
    r = max(min(round(real(x)*s), 32767), -32768);
    i = max(min(round(imag(x)*s), 32767), -32768);
    q = r + 1j*i;
end

function wr_iq(path, M)
%WR_IQ  按列优先逐点写 32 位 {im, re}
    v = M(:);
    re = mod(int32(real(v)), 65536);
    im = mod(int32(imag(v)), 65536);
    f = fopen(path, 'w');
    fprintf(f, '%08X\n', double(im)*65536 + double(re));
    fclose(f);
end

function wr_u16(path, M)
%WR_U16  按列优先逐点写无符号 16 位十六进制 (o_conf 只用低 12 位)
    v = M(:);
    f = fopen(path, 'w');
    fprintf(f, '%04X\n', double(v));
    fclose(f);
end

function wr_bit(path, B)
    v = B(:);
    f = fopen(path, 'w');
    fprintf(f, '%d\n', double(v));
    fclose(f);
end
