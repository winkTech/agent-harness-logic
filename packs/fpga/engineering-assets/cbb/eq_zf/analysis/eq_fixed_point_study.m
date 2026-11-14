function eq_fixed_point_study()
%EQ_FIXED_POINT_STUDY  eq_zf 进 RTL 前的定点分析 —— 回答 D5(a)(b) 与 D6(b)
%
%   需求门禁 eq_zf 的 D5 里还剩两项 assumed, D6 里还有一条未裁定的开口, 三者
%   都卡在同一件事上: **|H|^2 的实际分布**。没有它,
%     (a) 倒数的查表位宽 / 要不要 Newton  —— 定不了输入范围, 就定不了误差预算
%     (b) 输出定点格式与饱和策略          —— ZF 增益 1/|H|^2 的尾部有多重, 未知
%     (c) 除零/深衰落时 RTL 的显式行为    —— |H|^2 到底会不会真的取到 0, 未知
%   本脚本用治理侧的 golden 实测这个分布, 把三项从"拍脑袋"变成"按数据定"。
%
%   为什么不能照搬 channel_est 的 fixed_point_report: 那份报告分析的是 H 自身的
%   量化 (Q2.14, SQNR 86 dB), 结论是"H 够准"。均衡器的问题不是 H 准不准, 而是
%   **1/|H|^2 在深衰落时会炸到多大** —— 那是同一个 H 的完全不同的一面。
%
%   链路 (全部用治理资产, 不自造):
%     sim_channel/generate_rayleigh_channel  4 径频选 Rayleigh
%     lts_channel_est                        LTS-LS (channel_est_top 实现的正是它)
%     eq_zf                                  被定点化的对象
%
%   用法: matlab -batch "eq_fixed_point_study"

    rng(20260805, 'twister');                 % 固定种子: 结论要可复现

    EA   = fileparts(fileparts(fileparts(fileparts(mfilename('fullpath')))));
    EA   = fileparts(EA);                     % .../engineering-assets
    OFDM = fullfile(EA, 'models', 'comm', 'ofdm');
    CE   = fullfile(EA, 'models', 'comm', 'channel_est');
    addpath(fullfile(OFDM, 'src'), CE);

    % 路径优先级必须核实 —— 本轮踩过一次 (cwd 里的副本盖过 addpath 的治理资产)
    assert_governed('eq_zf',           fullfile(OFDM, 'src'));
    assert_governed('lts_channel_est', CE);
    assert_governed('sim_channel',     CE);

    cfg = local_cfg(CE);

    % ---- 子载波约定: 两个包不一样, 必须显式对齐 --------------------------
    % models/comm/ofdm (eq_zf/rx_chain): **有符号自然序**, 负下标绕到 N+idx,
    %   与 fft64_sdf 的 P_NATURAL_OUT=1 输出一致 —— 这才是 RTL 看到的顺序。
    % models/comm/channel_est/config.m: **fftshift 序** (data_idx 已 +33)。
    % 首版本脚本直接把后者喂给了 eq_zf, eq_zf 又按有符号约定转换, 结果读的 bin
    % 整体偏 +1: 48 个里只有 42 个是真数据载波, 其中 2 个还落在 lts 未用载波上
    % (那里 H 被 lts_channel_est 强制置 1.0)。此处改为统一用 ofdm 侧约定。
    cfg.ce_data_idx = cfg.data_idx;                         % 留一份原样 (fftshift 序):
                                                            % sim_channel 内部要用它放自己的 X
    cfg.data_idx = setdiff([-26:-1 1:26], [-21 -7 7 21]);   % 有符号, 供 eq_zf
    bins_ml = cfg.data_idx;
    bins_ml(bins_ml < 0) = cfg.N + bins_ml(bins_ml < 0);
    bins_ml = sort(bins_ml + 1);                            % 1-based, 供本脚本放数据
    cfg.bins_ml = bins_ml;

    % lts_seq 把 LTS 放在 (-26:26)+33, 即**也是 fftshift 序**。故 lts_channel_est
    % 产出的 H_est 是 fftshift 序, 必须 ifftshift 成自然序才能喂给 eq_zf。
    % 换算: fftshift 下标 j 的值落到自然序下标 mod(j-33,64)+1。
    [~, lts_used] = lts_seq(cfg.N);
    lts_used_nat  = sort(mod(lts_used(:).' - 33, cfg.N) + 1);

    % 硬断言: 用到的数据载波必须全都在 lts 的"已用载波"集合内, 否则 H 会是被
    % 置死的 1.0 而不是真实估计 —— 那正是首版本掉进去的坑。
    if ~isempty(setdiff(bins_ml, lts_used_nat))
        error('eq_fp:bins', '数据载波有 %d 个不在 lts 已用集合内', ...
              numel(setdiff(bins_ml, lts_used_nat)));
    end

    fprintf('========================================\n');
    fprintf('  eq_zf 定点分析 (D5a / D5b / D6b)\n');
    fprintf('========================================\n\n');

    %% ---- 1. 蒙特卡洛: 收集 |H|^2 与均衡输出的分布 -----------------------
    SNRS   = [10 20 30];
    NTRIAL = 400;                             % 每个 SNR 的信道实现数
    NSYM   = 8;                               % 每次实现的数据符号数

    stats = struct('snr', {}, 'h2', {}, 'xmag', {}, 'nzero', {}, 'ntot', {});
    for si = 1:numel(SNRS)
        [h2, xmag, nzero, ntot] = run_mc(cfg, SNRS(si), NTRIAL, NSYM);
        stats(si) = struct('snr', SNRS(si), 'h2', h2, 'xmag', xmag, ...
                           'nzero', nzero, 'ntot', ntot);
    end

    fprintf('--- 1. |H_est|^2 分布 (Q2.14 量化后, 仅 48 个数据子载波) ---\n');
    fprintf('%5s %12s %12s %12s %12s %12s\n', ...
            'SNR', 'min', 'p0.01%', 'p1%', '中位', 'max');
    for si = 1:numel(stats)
        h2 = stats(si).h2;
        fprintf('%5d %12.3e %12.3e %12.3e %12.3e %12.3e\n', stats(si).snr, ...
                min(h2), prctile_local(h2, 0.01), prctile_local(h2, 1), ...
                median(h2), max(h2));
    end
    fprintf('\n');

    fprintf('--- 1b. 逼近除零的频度 (|H_est|^2 低于阈值的比例) ---\n');
    THR = [2^-20 2^-16 2^-12 2^-8];
    fprintf('%5s', 'SNR');
    for t = THR, fprintf('%14s', sprintf('<2^%d', round(log2(t)))); end
    fprintf('%14s\n', '==0 (精确)');
    for si = 1:numel(stats)
        h2 = stats(si).h2;
        fprintf('%5d', stats(si).snr);
        for t = THR, fprintf('%13.3g%%', 100*mean(h2 < t)); end
        fprintf('%13.3g%%\n', 100*stats(si).nzero/stats(si).ntot);
    end
    fprintf('\n');

    %% ---- 2. 倒数实现: 查表位宽 x 有无 Newton ----------------------------
    % 归一化倒数: |H|^2 = m * 2^e, m in [0.5,1) -> 查 1/m, 再移位。
    % A 位地址的查表相对误差 ~ 2^-(A+1); 一次 Newton 迭代把它平方。
    fprintf('--- 2. 倒数实现: 相对误差 (对 1/|H|^2 的精确值) ---\n');
    h2_all = stats(2).h2;                     % SNR=20 dB 作代表工况
    h2_all = h2_all(h2_all > 0);
    fprintf('%8s %14s %14s %14s %14s\n', 'LUT位宽', '纯查表(max)', '纯查表(rms)', ...
            '+Newton(max)', '+Newton(rms)');
    for A = [6 8 10 12]
        [em0, er0] = recip_err(h2_all, A, 0);
        [em1, er1] = recip_err(h2_all, A, 1);
        fprintf('%8d %13.3e %13.3e %13.3e %13.3e\n', A, em0, er0, em1, er1);
    end
    fprintf('\n');
    fprintf('参考: Q2.14 输出的 1 LSB 相对分辨率随幅度变化, 判据见第 3 节的 EVM。\n\n');

    %% ---- 3. 输出定点格式: 均衡输出的幅度分布与饱和率 --------------------
    fprintf('--- 3. 均衡输出 |X| 分布 (发端星座为单位平均功率) ---\n');
    fprintf('%5s %12s %12s %12s %12s\n', 'SNR', '中位', 'p99%', 'p99.99%', 'max');
    for si = 1:numel(stats)
        xm = stats(si).xmag;
        fprintf('%5d %12.3f %12.3f %12.3f %12.3e\n', stats(si).snr, ...
                median(xm), prctile_local(xm, 99), prctile_local(xm, 99.99), max(xm));
    end
    fprintf('\n');

    fprintf('--- 3b. 候选输出格式的饱和率 (逐轴, 即 Re/Im 各自越界的比例) ---\n');
    FMTS = {'Q2.14', 2; 'Q3.13', 4; 'Q4.12', 8; 'Q5.11', 16; 'Q6.10', 32};
    fprintf('%8s %10s', '格式', '满量程');
    for si = 1:numel(stats), fprintf('%14s', sprintf('SNR=%d', stats(si).snr)); end
    fprintf('\n');
    for fi = 1:size(FMTS, 1)
        fs = FMTS{fi, 2};
        fprintf('%8s %10.0f', FMTS{fi, 1}, fs);
        for si = 1:numel(stats)
            fprintf('%13.3g%%', 100*mean(stats(si).xmag > fs));
        end
        fprintf('\n');
    end
    fprintf('\n');
    fprintf('注: |X| 是复数模, 逐轴越界比这更少 (轴分量 <= 模), 故上表是**保守上界**。\n\n');

    fprintf('========================================\n');
    fprintf('  分析完成 —— 结论见 README 的定点小节\n');
    fprintf('========================================\n');
end

% =====================================================================
function [h2, xmag, nzero, ntot] = run_mc(cfg, snr_db, ntrial, nsym)
    h2 = []; xmag = []; nzero = 0; ntot = 0;
    N = cfg.N;
    [X_lts, ~] = lts_seq(N);

    for t = 1:ntrial
        c = cfg; c.snr_db = snr_db;
        c.data_idx = cfg.ce_data_idx;         % sim_channel 只认 channel_est 的 fftshift 序

        % 真实信道 (借 sim_channel 的 rayleigh 分支; 只取 H, 它的 X/Y 不用)
        % H 按 freq=(0:N-1) 算, 是**自然序**
        [H_true, ~, ~, ~] = sim_channel(c);

        % --- LTS 段: 在 **fftshift 序**里做 (lts_seq/lts_channel_est 的约定) ---
        % H_true 出自 generate_rayleigh_channel, 按 freq=(0:N-1) 算, 是自然序;
        % 故送进 LTS 段前先 fftshift, 估计出来再 ifftshift 回自然序。
        sigma2   = mean(abs(H_true).^2) / 10^(snr_db/10);
        H_true_fs = fftshift(H_true);
        Y_lts = zeros(N, 2);
        for k = 1:2
            n = sqrt(sigma2/2) * (randn(N,1) + 1j*randn(N,1));
            Y_lts(:,k) = H_true_fs .* X_lts + n;
        end
        H_est = ifftshift(lts_channel_est(Y_lts, N));  % -> 自然序, 与 eq_zf 一致
        H_est = quant_q214(H_est);                     % channel_est_top 输出即 Q2.14

        % --- 数据段: 单位平均功率星座; 放在 1-based 自然序 bin 上 ---
        Xd = zeros(N, nsym);
        Xd(cfg.bins_ml, :) = qam_unit(16, numel(cfg.bins_ml), nsym);
        Yd = zeros(N, nsym);
        for s = 1:nsym
            n = sqrt(sigma2/2) * (randn(N,1) + 1j*randn(N,1));
            Yd(:,s) = H_true .* Xd(:,s) + n;
        end
        Yd = quant_q214(Yd);                          % fft64 输出即 Q2.14

        Hs = repmat(H_est, 1, nsym);

        % |H|^2 == 0 时 golden 会报错 —— 那正是 D6(b) 要的证据, 单独计数后跳过
        m2 = real(Hs(cfg.bins_ml,:)).^2 + imag(Hs(cfg.bins_ml,:)).^2;
        ntot  = ntot + numel(m2);
        nzero = nzero + sum(m2(:) == 0);
        if any(m2(:) == 0)
            continue;                                  % 本次实现无法送进 eq_zf
        end

        [xd, info] = eq_zf(Yd, Hs, cfg);
        h2   = [h2;   info.h_mag2(:)];                 %#ok<AGROW>
        xmag = [xmag; abs(xd(:))];                     %#ok<AGROW>
    end
end

% =====================================================================
function [emax, erms] = recip_err(h2, addr_bits, newton)
%RECIP_ERR  归一化查表倒数的相对误差。
%   |H|^2 = m*2^e (m in [0.5,1)); 查表给 1/m 的近似, 再按 e 移位。
%   移位是精确的, 故相对误差只由查表 (与可选的 Newton) 决定。
    e = floor(log2(h2));
    m = h2 ./ 2.^e;                                    % m in [1,2)
    m = m / 2; e = e + 1;                              % 归一到 [0.5,1)

    nlut = 2^addr_bits;
    idx  = min(nlut, max(1, floor((m - 0.5) * 2 * nlut) + 1));
    mc   = 0.5 + (idx - 0.5) / (2 * nlut);             % 表项对应的区间中点
    r    = 1 ./ mc;                                     % 表内容 (此处按无限精度存)

    if newton
        r = r .* (2 - m .* r);                          % 一次 Newton-Raphson
    end

    approx = r .* 2.^(-e);
    exact  = 1 ./ h2;
    rel    = abs(approx - exact) ./ exact;
    emax   = max(rel);
    erms   = sqrt(mean(rel.^2));
end

% =====================================================================
function y = quant_q214(x)
    s = 2^14; lim = (2^15 - 1) / s;
    q = @(v) min(max(round(v * s) / s, -lim), lim);
    y = q(real(x)) + 1j * q(imag(x));
end

function s = qam_unit(M, nrow, ncol)
%QAM_UNIT  单位平均功率方形 QAM, 自带映射 (不引入 Communications Toolbox 依赖)
    k = sqrt(M);
    lv = -(k-1):2:(k-1);
    p = mean(lv.^2) * 2;
    ri = lv(randi(k, nrow, ncol));
    ii = lv(randi(k, nrow, ncol));
    s = (ri + 1j*ii) / sqrt(p);
end

function v = prctile_local(x, p)
%PRCTILE_LOCAL  百分位 (不依赖 Statistics Toolbox)
    x = sort(x(:));
    if isempty(x), v = NaN; return; end
    i = max(1, min(numel(x), ceil(p/100 * numel(x))));
    v = x(i);
end

function cfg = local_cfg(ce_dir)
    here = pwd;
    cd(ce_dir);  cleaner = onCleanup(@() cd(here));
    config;                                            % 产生 cfg
    clear cleaner;
    % config.m 不设 cfg.M —— 它由调用方给 (run_channel_sim.m 第 14 行设 16)。
    % sim_channel 用它调 qammod, 故这里必须补上, 否则 sim_channel 直接报未定义。
    cfg.M = 16;
    if isempty(which('qammod'))
        error('eq_fp:toolbox', ...
              ['sim_channel 依赖 Communications Toolbox 的 qammod, 本机没有。' ...
               '本脚本只用它的 H (信道), 若该工具箱长期缺失, 应把 rayleigh 生成' ...
               '提取成治理侧的独立函数, 而不是在本脚本里另抄一份 —— 抄一份就会漂移。']);
    end
end

function assert_governed(fn, want_dir)
    got = which(fn);
    fprintf('  which(%-18s) = %s\n', fn, got);
    if isempty(got) || ~strncmpi(fullfile(got), fullfile(want_dir), numel(fullfile(want_dir)))
        error('eq_fp:path', '%s 解析到 %s, 不是治理资产 %s', fn, got, want_dir);
    end
end
