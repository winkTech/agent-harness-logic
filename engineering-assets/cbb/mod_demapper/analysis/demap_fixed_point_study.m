function demap_fixed_point_study()
%DEMAP_FIXED_POINT_STUDY  解调器进 RTL 前的定点分析 —— 回答 D5 的两项
%
%   (a) LLR 标度: 归一化 Min-Sum 在**数学上**对 LLR 的全局标度不敏感, 但**定点表示
%       不是**。Q(10,4) 的量程是 [-32, +31.9375], 分辨率 1/16:
%         标度太小 -> 大量 LLR 量化成 0, 译码器等于看到一片擦除, 信息直接丢光
%         标度太大 -> 饱和, 置信度被削平
%       两端都是丢信息, 中间有个甜点。这个甜点**只能测**, 不能拍。
%       首版自查已经露出苗头: sigma2=1 时无噪声 max|LLR| 只有 0.8, 即约 13 个 LSB,
%       量程绝大部分是空的。
%
%   (b) o_conf 位宽: 裁定⑤ 要 eq_zf 补出逐载波可靠度 |H|^2。|H|^2 跨约 18 个八度
%       (实测 2^-15 ~ 2^3), 直送 u32 太宽。eq_zf 内部已有归一化后的 M16 与 sh,
%       用它们的组合可能十几位就够 —— 但**够不够要按 LLR 的退化实测定, 不照搬**。
%
%   判据取"符号翻转率"而非单纯的误差幅度: LLR 的符号直接决定译码器看到的比特倾向,
%   翻一个号的代价远大于幅度偏一点。量化成 0 单列, 因为那是信息**丢光**而非变差。
%
%   用法: matlab -batch "addpath(<pkg>/analysis); demap_fixed_point_study"

    EA   = 'C:/Users/Lihan/.claude/engineering-assets';
    OFDM = fullfile(EA, 'models', 'comm', 'ofdm');
    CE   = fullfile(EA, 'models', 'comm', 'channel_est');
    addpath(fullfile(OFDM, 'src'), OFDM, CE);

    for f = {'mod_demapper_llr', 'eq_zf', 'lts_channel_est'}
        fprintf('  which(%-18s) = %s\n', f{1}, which(f{1}));
    end
    fprintf('\n');

    rng(20260805, 'twister');
    cfg = local_cfg(CE);

    % 子载波约定: ofdm 侧有符号自然序 (见 cbb/eq_zf/analysis/fixed-point-study.md §1.1)
    cfg.ce_data_idx = cfg.data_idx;
    cfg.data_idx = setdiff([-26:-1 1:26], [-21 -7 7 21]);
    bml = cfg.data_idx; bml(bml < 0) = cfg.N + bml(bml < 0);
    cfg.bins_ml = sort(bml + 1);

    MODS = {'QPSK', '16QAM', '64QAM'};
    SNRS = [10 20 30];

    fprintf('========================================\n');
    fprintf('  解调器定点分析 (D5a 标度 / D5b o_conf 位宽)\n');
    fprintf('========================================\n\n');

    %% ---- 采集: 理想 LLR 与逐载波权重 ------------------------------------
    D = struct('mod', {}, 'snr', {}, 'llr', {}, 'w', {});
    for mi = 1:numel(MODS)
        for si = 1:numel(SNRS)
            [llr, w] = collect(cfg, MODS{mi}, SNRS(si), 120);
            D(end+1) = struct('mod', MODS{mi}, 'snr', SNRS(si), 'llr', llr, 'w', w); %#ok<AGROW>
        end
    end

    %% ---- D5a: 标度扫描 --------------------------------------------------
    fprintf('--- D5a LLR 标度 K: 量化成 0 的比例 / 饱和率 / 符号翻转率 ---\n');
    fprintf('判据: Q(10,4) = round(K*LLR*16) 饱和到 [-512,511]\n\n');
    KS = [1 2 4 8 16 32 64];
    for mi = 1:numel(MODS)
        fprintf('%s @ SNR=20:\n', MODS{mi});
        fprintf('%6s %12s %12s %14s\n', 'K', '量化为0', '饱和', 'LLR相对误差');
        d = D(strcmp({D.mod}, MODS{mi}) & [D.snr] == 20);
        for K = KS
            [z, s, e] = q104(d.llr * K);
            fprintf('%6d %11.3g%% %11.3g%% %14.3g\n', K, 100*z, 100*s, e);
        end
        fprintf('\n');
    end

    %% ---- D5a 跨 SNR 复核 (甜点不能只在一个工况成立) ---------------------
    K_SEL = 16;
    fprintf('--- D5a K=%d 的跨 SNR 表现 ---\n', K_SEL);
    fprintf('%8s %6s %12s %12s %14s\n', '调制', 'SNR', '量化为0', '饱和', 'LLR相对误差');
    for mi = 1:numel(MODS)
        for si = 1:numel(SNRS)
            d = D(strcmp({D.mod}, MODS{mi}) & [D.snr] == SNRS(si));
            [z, s, e] = q104(d.llr * K_SEL);
            fprintf('%8s %6d %11.3g%% %11.3g%% %14.3g\n', MODS{mi}, SNRS(si), 100*z, 100*s, e);
        end
    end
    fprintf('\n');

    %% ---- D5b: o_conf 位宽 -----------------------------------------------
    % w = |H|^2 按"归一化尾数 + 指数"压缩: 取 nm 位尾数 + 6 位指数 (eq_zf 已有 M16/sh)
    fprintf('--- D5b o_conf 位宽: 压缩 w 后 LLR 的退化 ---\n');
    fprintf('压缩方式: w = m * 2^e, 保留 nm 位尾数 (eq_zf 内部已有 M16 与 sh, 直接截取)\n');
    fprintf('%8s %10s %14s %14s\n', '尾数位', '总位宽', '符号翻转率', 'LLR 相对误差');
    d = D(strcmp({D.mod}, '16QAM') & [D.snr] == 20);
    for nm = [2 3 4 5 6 8]
        wq = quant_w(d.w, nm);
        llr_q = d.llr .* (wq ./ max(d.w, eps));       % 权重换成量化版
        flip = mean(sign(llr_q(:)) ~= sign(d.llr(:)) & d.llr(:) ~= 0);
        rel  = median(abs(llr_q(:) - d.llr(:)) ./ max(abs(d.llr(:)), eps));
        fprintf('%8d %10d %13.3g%% %14.3g\n', nm, nm + 6, 100*flip, rel);
    end
    fprintf('\n');
    fprintf('注: 符号翻转率恒为 0 是应该的 —— w>0 的缩放不改变 LLR 的符号。\n');
    fprintf('    故 o_conf 的位宽由**幅度保真度**决定, 而不是由符号正确性决定。\n');

    fprintf('\n========================================\n');
    fprintf('  分析完成\n');
    fprintf('========================================\n');
end

% =====================================================================
function [llr, w] = collect(cfg, mod_type, snr_db, ntrial)
    N = cfg.N;
    [X_lts, ~] = lts_seq(N);
    bps = struct('QPSK', 2, 'x16QAM', 4, 'x64QAM', 6);
    key = mod_type; if key(1) >= '0' && key(1) <= '9', key = ['x' key]; end
    nb = bps.(key);
    nd = numel(cfg.bins_ml);

    llr = []; w = [];
    for t = 1:ntrial
        c = cfg; c.snr_db = snr_db; c.data_idx = cfg.ce_data_idx;
        [H_true, ~, ~, ~] = sim_channel(c);
        sigma2 = mean(abs(H_true).^2) / 10^(snr_db/10);

        Y_lts = zeros(N, 2);
        Hfs = fftshift(H_true);
        for k = 1:2
            n = sqrt(sigma2/2) * (randn(N,1) + 1j*randn(N,1));
            Y_lts(:,k) = Hfs .* X_lts + n;
        end
        H_est = quant_q214(ifftshift(lts_channel_est(Y_lts, N)));

        nsym = 4;
        Xd = zeros(N, nsym);
        Xd(cfg.bins_ml, :) = reshape(mod_mapper(randi([0 1], nb*nd*nsym, 1), mod_type), nd, nsym);
        Yd = zeros(N, nsym);
        for s = 1:nsym
            n = sqrt(sigma2/2) * (randn(N,1) + 1j*randn(N,1));
            Yd(:,s) = H_true .* Xd(:,s) + n;
        end
        Yd = quant_q214(Yd);
        Hs = repmat(H_est, 1, nsym);

        m2 = real(Hs(cfg.bins_ml,:)).^2 + imag(Hs(cfg.bins_ml,:)).^2;
        if any(m2(:) == 0), continue; end

        [xd, info] = eq_zf(Yd, Hs, cfg);
        ww = info.h_mag2;
        % **sigma2 取 1 而不是链路真值**: RTL 不知道噪声方差 (全链路无估计器,
        % 见裁定①), 它只会用一个固定标度。传真值等于把 1/(2σ²) 这个巨大的增益
        % 偷偷混进来 —— 首版就是这么写的, 结果 K=1 时就 80~99% 饱和, 荒谬到
        % 一眼能看出错。这里只留"加权距离度量", 标度全部交给 K。
        L  = mod_demapper_llr(xd, ww, mod_type, 1);
        llr = [llr; L(:)];                               %#ok<AGROW>
        w   = [w; repmat(ww(:), nb, 1)];                 %#ok<AGROW>
    end
    w = w(1:numel(llr));
end

% =====================================================================
function [zero_frac, sat_frac, rel_err] = q104(llr)
%Q104  按 Q(10,4) 量化并给出三项退化指标
%   符号翻转不作为指标: w>0 的缩放与对称舍入都不改符号, 它恒为 0, 没有信息量。
%   真正要看的是两端的信息损失 (量化为 0 / 饱和) 与整体保真度。
    q = round(llr * 16);
    sat_frac  = mean(abs(q(:)) > 511);
    q = max(min(q, 511), -512);
    zero_frac = mean(q(:) == 0 & llr(:) ~= 0);           % 信息丢光的那部分
    deq = q / 16;
    nz  = llr(:) ~= 0;
    rel_err = median(abs(deq(nz) - llr(nz)) ./ abs(llr(nz)));
end

function wq = quant_w(w, nm)
%QUANT_W  w = m*2^e, 尾数保留 nm 位 (与 eq_zf 内部的 M16/sh 同构)
    e = floor(log2(max(w, eps)));
    m = w ./ 2.^e;                                       % m in [1,2)
    mq = round((m - 1) * (2^nm)) / (2^nm) + 1;
    wq = mq .* 2.^e;
end

function y = quant_q214(x)
    s = 2^14; lim = (2^15 - 1) / s;
    q = @(v) min(max(round(v * s) / s, -lim), lim);
    y = q(real(x)) + 1j * q(imag(x));
end

function cfg = local_cfg(ce_dir)
    here = pwd;
    cd(ce_dir); cleaner = onCleanup(@() cd(here));
    config;
    clear cleaner;
    cfg.M = 16;
end
