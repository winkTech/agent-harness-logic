function gen_demap_vectors(mod_type)
%GEN_DEMAP_VECTORS  由 rtl_mirror_demap 导出 mod_demapper 顶层的位真判卷向量
%
%   期望值来自**治理侧的定点镜像**, 不是浮点锚直接量化, 因此判据是 **0 容差** ——
%   镜像与 RTL 走同一条整数路径, 任何差异都是缺陷而不是噪声。浮点锚 mod_demapper_llr
%   的角色在上一层: 它锁住镜像本身 (test_rtl_mirror_demap 的 T1), 不参与判卷。
%
%   激励刻意分类而非纯随机 —— 与 gen_eq_vectors 同一理由: 纯随机打不到边界, 而边界
%   正是最容易写错的地方。**这里的边界与均衡器完全不同**, 逐条给出为什么它危险:
%
%     符号 1..8    常规: 星座点 + 小噪声, conf 取常规 sh
%     符号 9       **恰好落在电平上** (噪声=0) —— metric 的一侧恰为 0,
%                  min 树若把 "<" 写成 "<=" 或反了, 这里最容易露头
%     符号 10      **恰好落在两电平中点** —— 两侧 d2 相等, metric=0, 判 0 分界
%     符号 11      **冲出星座之外** (|y| 远超最外电平) —— 所有比特同号, 且 metric
%                  达到最大, 逼出饱和路径
%     符号 12      **最大权重 sh=34** —— sh' 取最小值 28, 积最长, 饱和最易发生
%     符号 13      **最小权重 sh=3**  —— sh' 达 59~63, **超过积的位宽**, 结果须为 0
%                  而不是回绕。移位器写成定宽的话正好在这里错。
%     符号 14      **erasure 全拉** —— 输出须全 0 (裁定④ 闭环)
%     符号 15      **conf=0 但不拉 erasure** —— 数据通路自身也须给 0 (双保险一路)
%     符号 16..48  满幅随机压力 (凑够 G-B-03 的 >=2048 点)
%
%   输出 (vectors/<mod>/):
%     x.hex        NSYM*48 行, 32 位 {im, re}, Q4.12
%     conf.hex     NSYM*48 行, 3 位十六进制 (12 位)
%     er.hex       NSYM*48 行, 0/1
%     llr_exp.hex  NSYM*48*bps 行, 3 位十六进制 (10 位有符号的二进制补码), b0 在前
%     lev.hex      nlev 行, 4 位十六进制 —— **RTL 的电平 ROM 就取这个文件**
%     vec_config.txt
%
%   打包字序 **{im, re}** —— 与 eq_zf 的 m_axis 一致, 上游直接对接。
%   本链路上 fft64_sdf 的判卷 TB 用的是 {re, im}, 曾因此产生假失配。
%
%   用法: matlab -batch "addpath(<pkg>/analysis); gen_demap_vectors('16QAM')"

    if nargin < 1 || isempty(mod_type), mod_type = '16QAM'; end

    EA   = 'C:/Users/Lihan/.claude/engineering-assets';
    addpath(fullfile(EA, 'models', 'comm', 'ofdm', 'src'));
    if isempty(which('rtl_mirror_demap'))
        error('gen_demap_vectors:golden', ...
              ['镜像未解析到治理侧 —— 判卷向量的期望值只能来自 models/comm/ofdm/src, ' ...
               '不得回退到任何副本。(入库前曾用 incubator/staging 的临时副本, ' ...
               '1.8.0 入库后该副本已删除, 免得两份 golden 并存漂移。)']);
    end
    fprintf('  which(rtl_mirror_demap) = %s\n', which('rtl_mirror_demap'));

    here = fileparts(mfilename('fullpath'));
    OUT  = fullfile(here, '..', 'vectors', lower(mod_type));
    if ~exist(OUT, 'dir'), mkdir(OUT); end

    rng(20260805);
    ND   = 48;
    NSYM = 48;                                       % 48*48 = 2304 点, 过 G-B-03 的 >=2048
    bps  = bits_per_symbol(mod_type);

    [~, inf0] = rtl_mirror_demap(complex(0, 0), 2048, false, mod_type);
    lev  = inf0.levels(:);
    K    = inf0.k_scale;
    lmax = max(lev);

    x  = zeros(ND, NSYM);
    cf = zeros(ND, NSYM);
    er = false(ND, NSYM);

    % 常规 conf: sh 覆盖中段, man 满量程
    rnd_conf = @() randi([8 30], ND, 1) * 64 + randi([0 63], ND, 1);
    % 随机星座点 (每轴独立选一个电平)
    pick = @() lev(randi(numel(lev), ND, 1));

    for s = 1:NSYM
        cf(:, s) = rnd_conf();
        switch s
            case num2cell(1:8)                      % 常规: 星座点 + 小噪声
                x(:, s) = complex(pick() + round(randn(ND,1)*200), ...
                                  pick() + round(randn(ND,1)*200));
            case 9                                   % 恰在电平上, 噪声为 0
                x(:, s) = complex(pick(), pick());
            case 10                                  % 紧贴两电平中点 (平局边界)
                % 真中点多半不是 Q4.12 整数 (16QAM 的 -2590.5), RTL 永远见不到它。
                % 于是取**中点两侧最近的可表示点**去夹逼平局: 两点的 metric 符号
                % 必须相反且幅度极小 —— min 树的比较写反了, 这里立刻分岔。
                mid = (lev(1:end-1) + lev(2:end)) / 2;
                pair = [floor(mid); ceil(mid)];
                mm = pair(randi(numel(pair), ND, 1));
                mq = pair(randi(numel(pair), ND, 1));
                x(:, s) = complex(mm, mq);
            case 11                                  % 冲出星座之外
                x(:, s) = complex(randi([lmax*4, 32767], ND, 1) .* sign(randn(ND,1)+eps), ...
                                  randi([lmax*4, 32767], ND, 1) .* sign(randn(ND,1)+eps));
            case 12                                  % 最大权重 -> sh' 最小
                cf(:, s) = 34*64 + randi([0 63], ND, 1);
                x(:, s)  = complex(pick()*3, pick()*3);
            case 13                                  % 最小权重 -> sh' 超过积位宽
                cf(:, s) = 3*64 + randi([0 63], ND, 1);
                x(:, s)  = complex(pick()*3, pick()*3);
            case 14                                  % erasure 全拉
                er(:, s) = true;
                x(:, s)  = complex(pick(), pick());
            case 15                                  % conf=0 但不拉 erasure
                cf(:, s) = 0;
                x(:, s)  = complex(pick(), pick());
            otherwise                                % 满幅随机压力
                x(:, s) = complex(round((rand(ND,1)*2-1)*32767), ...
                                  round((rand(ND,1)*2-1)*32767));
        end
    end
    x = max(min(real(x), 32767), -32768) + 1j*max(min(imag(x), 32767), -32768);

    llr = rtl_mirror_demap(x, cf, er, mod_type);
    [~, info] = rtl_mirror_demap(x, cf, er, mod_type);

    %% --- 自查: 判卷向量若自己就没覆盖到目标路径, TB 全绿也说明不了什么 ---
    Lm = reshape(double(llr), bps, ND*NSYM).';
    chk = struct();
    chk.n_sat   = sum(Lm(:) >= 511 | Lm(:) <= -512);
    chk.n_zero  = sum(Lm(:) == 0);
    chk.n_er0   = sum(sum(abs(Lm(reshape(er, [], 1), :)), 2) == 0);
    chk.sh_span = info.shift_range;
    fprintf('\n  覆盖自查:\n');
    fprintf('    饱和点 %d (须 >0, 否则 s12 没打到饱和路径)\n', chk.n_sat);
    fprintf('    零值   %d\n', chk.n_zero);
    fprintf('    erasure 载波全 0 的行数 %d / %d\n', chk.n_er0, sum(er(:)));
    fprintf('    sh'' 跨度 [%d, %d] (须含 >=48 那一支, 即 s13)\n', chk.sh_span(1), chk.sh_span(2));
    if chk.n_sat == 0
        error('gen_demap_vectors:cov', '向量未打到饱和路径 —— 边界符号设计失效');
    end
    if chk.sh_span(2) < 48
        error('gen_demap_vectors:cov', 'sh'' 未达 48 —— 超宽移位那一支没被覆盖');
    end
    if chk.n_er0 ~= sum(er(:))
        error('gen_demap_vectors:cov', 'erasure 载波未全部输出 0');
    end

    %% --- 落盘 ---
    write_hex(fullfile(OUT, 'x.hex'), pack_iq(x), 8);
    write_hex(fullfile(OUT, 'conf.hex'), cf(:), 3);
    write_hex(fullfile(OUT, 'er.hex'), double(er(:)), 1);
    write_hex(fullfile(OUT, 'llr_exp.hex'), tc(double(llr(:)), 10), 3);
    write_hex(fullfile(OUT, 'lev.hex'), tc(lev, 16), 4);

    f = fopen(fullfile(OUT, 'vec_config.txt'), 'w');
    fprintf(f, 'MOD=%s\nBPS=%d\nK=%d\nND=%d\nNSYM=%d\nNLEV=%d\n', ...
            upper(mod_type), bps, K, ND, NSYM, numel(lev));
    fprintf(f, 'SHIFT_MIN=%d\nSHIFT_MAX=%d\n', info.shift_range(1), info.shift_range(2));
    fprintf(f, 'N_SAT=%d\nN_ERASURE=%d\n', chk.n_sat, sum(er(:)));
    fprintf(f, 'SPEC=%s\n', info.spec);
    fprintf(f, 'WORD_ORDER={im,re}\nLLR_ORDER=b0_first\n');
    fclose(f);

    fprintf('\n  已写出 %s (%d 点, %d 个 LLR)\n', OUT, ND*NSYM, numel(llr));
end

% =====================================================================
function v = pack_iq(x)
%PACK_IQ  {im[31:16], re[15:0]}, 各为 16 位二进制补码
    re = tc(double(real(x(:))), 16);
    im = tc(double(imag(x(:))), 16);
    v  = im * 65536 + re;
end

function u = tc(v, w)
%TC  转 w 位二进制补码的无符号表示
    u = mod(round(v), 2^w);
end

function write_hex(path, v, ndig)
    f = fopen(path, 'w');
    fprintf(f, ['%0' num2str(ndig) 'X\n'], v);
    fclose(f);
end

function bps = bits_per_symbol(m)
    switch upper(m)
        case 'QPSK',  bps = 2;
        case '16QAM', bps = 4;
        case '64QAM', bps = 6;
        otherwise, error('gen_demap_vectors:mod', '不支持: %s', m);
    end
end
