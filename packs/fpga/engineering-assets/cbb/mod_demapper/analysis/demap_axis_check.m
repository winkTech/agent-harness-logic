function demap_axis_check()
%DEMAP_AXIS_CHECK  进 RTL 前的结构判定: max-log LLR 能否按 I/Q 两轴分解?
%
%   这决定 RTL 的算力: 治理侧的 mod_demapper_llr 是对**整个 M 点星座**穷举求最小距离
%   (64QAM 即 64 个)。若方形 QAM 的 max-log 可按轴分解, 每轴只需 sqrt(M) 个电平
%   (64QAM -> 8), 算力降一个数量级, 且每轴的比特互不相干、可并行。
%
%   **但这必须验证而不是假定**: 分解成立的前提是 (a) 星座是 I/Q 可分的方形网格,
%   (b) 比特标号也按轴划分 (前一半比特只由 I 决定, 后一半只由 Q 决定)。mod_mapper
%   的 Gray 映射是否满足 (b), 只能查, 不能凭"方形 QAM 一般都这样"。
%
%   判据: 逐点比对分解式与治理侧锚的输出, 必须**逐位相同**(浮点下 0 偏差)。
%
%   用法: matlab -batch "addpath(<pkg>/analysis); demap_axis_check"

    EA   = 'C:/Users/Lihan/.claude/engineering-assets';
    OFDM = fullfile(EA, 'models', 'comm', 'ofdm');
    addpath(fullfile(OFDM, 'src'));
    fprintf('  which(mod_demapper_llr) = %s\n\n', which('mod_demapper_llr'));

    rng(20260805);
    mods = {'QPSK', '16QAM', '64QAM'};
    bpsv = [2 4 6];
    scal = [sqrt(2), sqrt(10), sqrt(42)];      % mod_mapper 的功率归一化因子

    fprintf('========================================\n');
    fprintf('  max-log LLR 的 I/Q 两轴可分性判定\n');
    fprintf('========================================\n\n');

    for k = 1:numel(mods)
        m = mods{k}; bps = bpsv(k); half = bps / 2;

        %% --- 先查前提 (b): 比特标号是否按轴划分 ---------------------------
        % 枚举全部 M 个比特组合, 看前 half 位是否只影响 I、后 half 位是否只影响 Q
        M = 2^bps;
        I = zeros(M,1); Q = zeros(M,1); L = zeros(M, bps);
        for v = 0:M-1
            b = double(bitget(v, bps:-1:1)).';
            s = mod_mapper(b(:), m);
            I(v+1) = real(s); Q(v+1) = imag(s); L(v+1,:) = b.';
        end
        % 对每个比特位, 检查它是否只与 I (或只与 Q) 相关:
        % 固定其余比特时, 翻转该位若只改变 I 则属 I 轴
        axis_of = zeros(1, bps);
        for bi = 1:bps
            dI = false; dQ = false;
            for v = 0:M-1
                w = bitxor(v, bitshift(1, bps-bi));    % 翻转第 bi 位
                if abs(I(v+1) - I(w+1)) > 1e-12, dI = true; end
                if abs(Q(v+1) - Q(w+1)) > 1e-12, dQ = true; end
            end
            if dI && ~dQ,      axis_of(bi) = 1;        % 只影响 I
            elseif dQ && ~dI,  axis_of(bi) = 2;        % 只影响 Q
            else,              axis_of(bi) = 0;        % 两轴都影响 -> 不可分
            end
        end
        sep_ok = all(axis_of ~= 0) && isequal(axis_of, [ones(1,half), 2*ones(1,half)]);
        fprintf('%-6s 比特轴归属 = %s  (期望 前%d位属I, 后%d位属Q)  可分=%d\n', ...
                m, mat2str(axis_of), half, half, sep_ok);

        %% --- 再验分解式与治理侧锚逐点一致 --------------------------------
        n = 4000;
        x = (randn(n,1) + 1j*randn(n,1)) * 0.8;
        w = rand(n,1) * 2;                      % 逐点权重
        Lref = mod_demapper_llr(x, w, m, 1);
        Lref = reshape(Lref, bps, n).';

        % 分解式: 每轴独立, 只对 sqrt(M) 个电平求最小平方距离
        lev_i = unique(round(I * scal(k) * 1e6) / 1e6);   % 该轴的电平 (归一化前)
        lev_i = lev_i(:) / scal(k);
        nlev  = numel(lev_i);
        % 电平的比特标号: 取任一含该电平的星座点的 I 轴比特
        lab_i = zeros(nlev, half);
        for li = 1:nlev
            idx = find(abs(I - lev_i(li)) < 1e-12, 1);
            lab_i(li,:) = L(idx, 1:half);
        end

        Ldec = zeros(n, bps);
        for ax = 1:2
            y = (ax == 1) .* real(x) + (ax == 2) .* imag(x);
            d2 = (y - lev_i.').^2;                       % [n x nlev]
            for bi = 1:half
                is1  = lab_i(:, bi) == 1;
                min1 = min(d2(:, is1),  [], 2);
                min0 = min(d2(:, ~is1), [], 2);
                col  = (ax-1)*half + bi;
                Ldec(:, col) = (min1 - min0) / 2 .* w;
            end
        end

        dmax = max(abs(Ldec(:) - Lref(:)));
        fprintf('       分解式 vs 治理侧锚 (%d 点 x %d 位): 最大偏差 %.3g\n\n', n, bps, dmax);
        if ~sep_ok || dmax > 1e-12
            error('demap_axis:sep', '%s 不满足两轴分解前提 —— RTL 不能按轴做', m);
        end
    end

    fprintf('结论: 三种调制均可按 I/Q 两轴分解, 每轴只需 sqrt(M) 个电平\n');
    fprintf('      (QPSK 2 / 16QAM 4 / 64QAM 8), 且两轴比特互不相干可并行。\n');
    fprintf('      RTL 因此不必对整星座穷举 —— 64QAM 由 64 个距离降到每轴 8 个。\n');
end
