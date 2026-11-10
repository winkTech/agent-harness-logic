function demap_e2e_ber()
%DEMAP_E2E_BER  端到端 BER 定 LLR 标度 K —— D3 判据(2) 与 D5a 的最终判据
%
%   demap_fixed_point_study 给出的是**代理判据** (量化为 0 的比例 vs 饱和率), 它划出了
%   范围但定不了唯一解: 饱和只是削平置信度, 对 Min-Sum 相对良性; 量化为 0 是丢方向,
%   代价更重。两者代价不对等, 靠比例数字比不出来。真正的判据只能是**端到端误码**。
%
%   全链路 (每一环都用治理侧资产, 不自造):
%     info(324) -> ldpc_encode_80211n -> code(648) -> mod_mapper -> 子载波映射
%       -> Rayleigh 信道 + 噪声 -> lts_channel_est -> eq_zf -> mod_demapper_llr
%       -> xK -> ldpc_decoder_ms_fixed (Q(10,4), alpha=0.75, 20 迭代) -> BER
%
%   注意 ldpc_decoder_ms_fixed 自己按 q_config 做量化, 故这里传**浮点 LLR x K**,
%   由它完成 Q(10,4) 的量化与饱和 —— 与 RTL 的分工一致。
%
%   用法: matlab -batch "addpath(<pkg>/analysis); demap_e2e_ber"

    EA   = 'C:/Users/Lihan/.claude/engineering-assets';
    OFDM = fullfile(EA, 'models', 'comm', 'ofdm');
    CE   = fullfile(EA, 'models', 'comm', 'channel_est');
    LDPC = fullfile(EA, 'models', 'comm', 'ldpc');
    addpath(fullfile(OFDM, 'src'), OFDM, CE, fullfile(LDPC, 'src'), LDPC);

    for f = {'mod_demapper_llr', 'eq_zf', 'ldpc_decoder_ms_fixed', 'ldpc_encode_80211n'}
        fprintf('  which(%-22s) = %s\n', f{1}, which(f{1}));
    end
    fprintf('\n');

    rng(20260805, 'twister');
    cfg = local_cfg(CE);
    cfg.ce_data_idx = cfg.data_idx;
    cfg.data_idx = setdiff([-26:-1 1:26], [-21 -7 7 21]);
    % **不排序** —— eq_zf 按 cfg.data_idx 的原序返回行, 放置也必须按同一序。
    % 排序过就整体置换了: 实测理想信道下与发端比特差 270/576 (≈随机), 而原序放置差 0/576。
    % 这是本轮第四次栽在子载波顺序上 (判卷向量行序 / RTL 重排 / 定点研究 / 本脚本),
    % 同一个约定换个场景就又踩一次, 故在此写死并由 T0 式的理想信道自查兜住。
    b = cfg.data_idx; b(b < 0) = cfg.N + b(b < 0);
    cfg.bins_ml = b + 1;

    lc = ldpc_cfg(LDPC);
    H  = generate_h_matrix(lc);
    K_INFO = 324; N_CODE = 648;

    qcfg = struct('total_bits', 10, 'frac_bits', 4);   % 与 cbb/ldpc_codec 的 Q(10,4) 一致

    % 每种调制选**各自瀑布区**的 SNR: 统一 SNR 会让低阶调制 BER 压到 0, 那样 K 之间
    % 分不出高下 (首轮 SNR=14 时 QPSK/16QAM 齐刷刷 0, 只有 64QAM 有区分度)。
    % 判据要落在能分辨的区间, 否则"最优 K"只是并列第一里随手挑的一个。
    MODS  = {'QPSK', '16QAM', '64QAM'};
    SNRS  = [  4,      10,      18   ];
    % 收窄 K 并加帧数: 首轮 40 帧下 16QAM/64QAM 的最优点被噪声淹没 (64QAM 出现两个 0),
    % 那种"最优"是随手挑的。QPSK 单调递减故往下探到 1。
    KS    = [1 2 4 8 16 32];
    NTRI  = 100;

    % T0 前置自查: 理想信道下必须逐比特还原。不先证明"链路本身是通的",
    % 后面扫出来的 BER 都可能只是接线错了 —— 首版就是这样, 三种调制齐刷刷 0.5。
    if ~ideal_loopback(cfg)
        error('demap_e2e:loopback', 'T0 理想信道回环失败 —— 先修接线, 不要看 BER');
    end
    fprintf('  [T0] 理想信道回环: 逐比特还原 OK\n\n');

    fprintf('========================================\n');
    fprintf('  端到端 BER 定标度 K (%d 帧/点, Q(10,4), 每调制取各自瀑布区 SNR)\n', NTRI);
    fprintf('========================================\n\n');
    fprintf('%8s %5s', '调制', 'SNR');
    for K = KS, fprintf('%11s', sprintf('K=%d', K)); end
    fprintf('\n');

    best = struct();
    for mi = 1:numel(MODS)
        fprintf('%8s %5d', MODS{mi}, SNRS(mi));
        bers = zeros(size(KS));
        for ki = 1:numel(KS)
            bers(ki) = run_ber(cfg, lc, H, MODS{mi}, SNRS(mi), KS(ki), NTRI, K_INFO, N_CODE, qcfg);
            fprintf('%11.3g', bers(ki));
        end
        [~, bi] = min(bers);
        best.(matlab.lang.makeValidName(MODS{mi})) = KS(bi);
        fprintf('   <- 最优 K=%d\n', KS(bi));
    end

    fprintf('\n--- 结论 ---\n');
    fn = fieldnames(best);
    for i = 1:numel(fn)
        fprintf('  %-8s 最优 K = %d\n', MODS{i}, best.(fn{i}));
    end
    fprintf('\n端到端 BER 是唯一能把 K 定死的判据: 代理指标 (量化为0 vs 饱和) 代价不对等, 比不出来。\n');
end

% =====================================================================
function ber = run_ber(cfg, lc, H, mod_type, snr_db, K, ntrial, KI, NC, qcfg)
    N = cfg.N;
    [X_lts, ~] = lts_seq(N);
    bps = bits_of(mod_type);
    nd  = numel(cfg.bins_ml);
    nsym = ceil(NC / (bps * nd));
    npad = nsym * bps * nd - NC;

    nerr = 0; nbit = 0;
    for t = 1:ntrial
        info = randi([0 1], KI, 1);
        code = double(ldpc_encode_80211n(info, H, lc));
        tx_b = [code; zeros(npad, 1)];

        c = cfg; c.snr_db = snr_db; c.data_idx = cfg.ce_data_idx;
        [H_true, ~, ~, ~] = sim_channel(c);
        sigma2 = mean(abs(H_true).^2) / 10^(snr_db/10);

        Y_lts = zeros(N, 2); Hfs = fftshift(H_true);
        for k = 1:2
            n = sqrt(sigma2/2) * (randn(N,1) + 1j*randn(N,1));
            Y_lts(:,k) = Hfs .* X_lts + n;
        end
        H_est = quant_q214(ifftshift(lts_channel_est(Y_lts, N)));

        Xd = zeros(N, nsym);
        Xd(cfg.bins_ml, :) = reshape(mod_mapper(tx_b, mod_type), nd, nsym);
        Yd = zeros(N, nsym);
        for s = 1:nsym
            n = sqrt(sigma2/2) * (randn(N,1) + 1j*randn(N,1));
            Yd(:,s) = H_true .* Xd(:,s) + n;
        end
        Yd = quant_q214(Yd);
        Hs = repmat(H_est, 1, nsym);

        m2 = real(Hs(cfg.bins_ml,:)).^2 + imag(Hs(cfg.bins_ml,:)).^2;
        if any(m2(:) == 0), continue; end

        [xd, info_eq] = eq_zf(Yd, Hs, cfg);
        L = mod_demapper_llr(xd, info_eq.h_mag2, mod_type, 1) * K;
        L = L(:); L = L(1:NC);

        dec = ldpc_decoder_ms_fixed(L, H, 20, 0.75, qcfg);
        nerr = nerr + sum(dec(:) ~= info(:));
        nbit = nbit + KI;
    end
    ber = nerr / max(nbit, 1);
end

function ok = ideal_loopback(cfg)
%IDEAL_LOOPBACK  理想信道 (H=1, 无噪声) 下 LLR 硬判决必须逐比特还原发端
    N = cfg.N; nd = numel(cfg.bins_ml); nsym = 3; bps = 4;
    bits = randi([0 1], bps*nd*nsym, 1);
    S = reshape(mod_mapper(bits, '16QAM'), nd, nsym);
    X = zeros(N, nsym); H = zeros(N, nsym);
    X(cfg.bins_ml, :) = S;  H(cfg.bins_ml, :) = 1;
    xd = eq_zf(X, H, cfg);
    L  = mod_demapper_llr(xd, 1, '16QAM', 1);
    ok = all(double(L(:) < 0) == bits);
end

function n = bits_of(m)
    switch upper(m)
        case 'BPSK', n = 1; case 'QPSK', n = 2;
        case '16QAM', n = 4; case '64QAM', n = 6;
        otherwise, error('bad mod');
    end
end

function y = quant_q214(x)
    s = 2^14; lim = (2^15 - 1) / s;
    q = @(v) min(max(round(v * s) / s, -lim), lim);
    y = q(real(x)) + 1j * q(imag(x));
end

function cfg = local_cfg(d)
    here = pwd; cd(d); cleaner = onCleanup(@() cd(here)); config; clear cleaner; cfg.M = 16;
end

function cfg = ldpc_cfg(d)
    here = pwd; cd(d); cleaner = onCleanup(@() cd(here)); config; clear cleaner;
end
