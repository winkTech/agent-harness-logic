function ok = chain_pilot_contract()
%CHAIN_PILOT_CONTRACT  跨包判据: TX -> RX 的导频约定必须能真的把 CPE 找回来
%
%   为什么需要这一条: 库里每个包各自都是绿的, 因为**各自的 TB 与各自的 RTL 用同一套
%   约定互相印证**。TX 侧 (models/comm/ofdm + cbb/ofdm_tx_top) 与 RX 侧
%   (models/comm/channel_est + cbb/channel_est_top) 之间从来没有一条判据, 于是两边
%   对"导频值放在哪个子载波取负"的约定可以长期相反而无人察觉。
%
%   判据刻意**不是**"读两边代码比对常数" —— 那还是读代码。这里走实跑:
%     用治理侧 TX golden 造帧 -> 加已知信道 H 与**已知公共相位 theta** ->
%     用治理侧 RX golden 的 pilot_phase_track 去恢复 -> 恢复值必须等于 theta。
%   约定错了, theta 就找不回来; 这比"常数不相等"更有说服力, 也更难被一句
%   "那只是注释写法不同" 搪塞过去。
%
%   两侧的约定都**从各自包的源文件里读出来**, 不在本文件里手填 —— 手填等于把要
%   比对的东西自己又写了一遍, 测的就成了我抄得对不对。
%
%   用法: matlab -batch "addpath('<ea>/integration/contracts'); chain_pilot_contract"

    ok = false;
    EA = fileparts(fileparts(fileparts(mfilename('fullpath'))));   % contracts -> integration -> <ea>
    addpath(fullfile(EA, 'models', 'comm', 'ofdm'));
    addpath(fullfile(EA, 'models', 'comm', 'ofdm', 'src'));
    addpath(fullfile(EA, 'models', 'comm', 'channel_est'));

    fails = 0;
    fprintf('========================================\n');
    fprintf('  跨包导频约定判据 (TX -> RX 实跑 CPE 恢复)\n');
    fprintf('========================================\n\n');

    %% ---- 1. 两侧各自声明的约定, 从源文件读出来 ----
    % **按全路径显式加载**, 不用裸 `config`: models/comm/ofdm 与 models/comm/channel_est
    % 各有一份 config.m, 裸调用取决于谁在 MATLAB 路径前面 —— 首版就在这栽了 (取到了
    % channel_est 的那份, 它没有 pilot_val)。这本身就是同一类跨包隐患。
    run(fullfile(EA, 'models', 'comm', 'ofdm', 'config.m'));   % 定义 cfg
    tx_sc  = cfg.pilot_idx(:).';                       % 有符号子载波
    tx_val = cfg.pilot_val(:).';
    fprintf('TX 侧 (models/comm/ofdm/config.m):\n');
    fprintf('   子载波 %s  值 %s\n', mat2str(tx_sc), mat2str(tx_val));

    [rx_sc, rx_val, rx_pol, rx_src] = read_rx_convention(EA);
    fprintf('RX 侧 (%s):\n', rx_src);
    fprintf('   子载波 %s  值 %s  逐符号极性=%d\n\n', mat2str(rx_sc), mat2str(rx_val), rx_pol);
    if ~rx_pol
        fprintf('  [FAIL] RX 侧不施加逐符号极性 —— TX 侧逐符号翻转, 每隔一个符号 CPE 差 pi\n');
        fails = fails + 1;
    end

    %% ---- 2. 位置集合必须相同 (值的差异留给实跑去暴露) ----
    if ~isequal(sort(tx_sc), sort(rx_sc))
        fprintf('  [FAIL] 两侧导频**位置**就不一致, 后面的实跑无从谈起\n');
        fails = fails + 1;
    end

    %% ---- 3. 实跑: TX golden 造帧 -> 已知 theta -> RX golden 恢复 ----
    rng(20260809);
    nsym  = 6;
    theta = [0.31, -0.77, 1.20, -0.05, 2.10, -1.55];   % 每符号注入的已知公共相位
    data  = mod_mapper_bits(cfg, nsym);
    X_nat = subcarrier_map(data, cfg);                 % 自然序 (bin = mod(k,64))

    % 非平坦信道: 平坦时错误约定恰好抵消为 0, 反而看不出 angle 的偏差有多离谱
    H_nat = (0.6 + 0.8*rand(cfg.N, 1)) .* exp(1j*2*pi*rand(cfg.N, 1));

    fprintf('  实跑 %d 个符号, 逐符号注入已知公共相位并要求原样恢复:\n', nsym);
    fprintf('%8s %12s %12s %12s\n', '符号', '注入 theta', '恢复 CPE', '误差(rad)');

    worst = 0;
    for s = 1:nsym
        Y_nat = H_nat .* X_nat(:, s) * exp(1j*theta(s));
        % RX 侧全程用 fftshift 序 (channel_est 的约定), 故换序后再交给它
        Y_rx = fftshift(Y_nat);
        H_rx = fftshift(H_nat);
        idx  = rx_sc + 33;                             % 1-based fftshift 下标
        % RX 施加的导频值 = 值模式 x 该符号极性 (两者都从 RTL 源文件读出来)
        pol_rx = 1;
        if rx_pol, pol_rx = 1 - 2*mod(s-1, 2); end
        [~, cpe] = pilot_phase_track(Y_rx, H_rx, idx, pol_rx * rx_val(:));
        err = angle(exp(1j*(cpe - theta(s))));         % 绕回 (-pi, pi]
        worst = max(worst, abs(err));
        fprintf('%8d %12.4f %12.4f %12.4f\n', s, theta(s), cpe, err);
    end

    fprintf('\n  最大恢复误差 = %.4f rad\n', worst);
    if worst > 1e-6
        fprintf('  [FAIL] CPE 恢复不出来 —— TX 与 RX 的导频约定不自洽\n');
        fprintf('         (平坦信道下四项会恰好抵消, angle(0) 无定义; 此处用非平坦信道,\n');
        fprintf('          得到的是一个符号乱跳的残差 —— 两种都不是能用的 CPE)\n');
        fails = fails + 1;
    end

    %% ---- 4. 反证: 极性机制是**承重**的, 不是摆设 ----
    % 判据全绿之后最容易滑向的状态是"它一直绿, 所以它没在测什么"。这里把 RX 的极性
    % 拿掉再跑一遍: 必须立刻坏掉。坏不掉就说明极性那段代码不承重, 判据也就白写了。
    % (2026-08-09 首次运行时, 这一段正是用来把"导频值错"与"极性缺失"两个缺陷分开的;
    %  两者都修好后, 它转为反证极性机制有效。)
    fprintf('  反证 —— 人为去掉 RX 的逐符号极性, 应立刻坏掉:\n');
    worst2 = 0;
    for s = 1:nsym
        Y_nat = H_nat .* X_nat(:, s) * exp(1j*theta(s));
        [~, cpe2] = pilot_phase_track(fftshift(Y_nat), fftshift(H_nat), rx_sc + 33, rx_val(:));
        e2 = angle(exp(1j*(cpe2 - theta(s))));
        worst2 = max(worst2, abs(e2));
    end
    fprintf('    去掉极性后最大误差 = %.4f rad (应约 pi)\n', worst2);
    if worst2 < 3.0
        fprintf('  [FAIL] 去掉极性居然还能恢复 —— 极性机制不承重, 本判据没在测它\n');
        fails = fails + 1;
    else
        fprintf('  => 承重: 去掉即差 pi, 说明极性那段是真的在起作用。\n');
    end

    fprintf('\n');
    if fails > 0
        error('chain_pilot_contract:fail', '跨包导频约定判据: %d 条未过', fails);
    end
    fprintf('RESULT: PASS - chain_pilot_contract\n');
    ok = true;
end

% =====================================================================
function [sc, val, pol, src] = read_rx_convention(EA)
%READ_RX_CONVENTION  从 RX 侧**自己的源文件**读出它假设的导频约定。
%   优先取已认证 RTL (cbb/channel_est_top/rtl/cpe_tracker.sv) —— 它才是集成时真正
%   跑的东西; golden 侧的 generate_vectors.m 作为交叉印证。

    f = fullfile(EA, 'cbb', 'channel_est_top', 'rtl', 'cpe_tracker.sv');
    txt = fileread(f);

    % localparam int P_PILOT_POS [4] = '{11, 25, 39, 53};
    m = regexp(txt, 'P_PILOT_POS\s*\[\s*4\s*\]\s*=\s*''\{([^}]*)\}', 'tokens', 'once');
    if isempty(m)
        error('chain_pilot_contract:parse', '从 cpe_tracker.sv 读不出 P_PILOT_POS');
    end
    bins = str2double(strsplit(strtrim(m{1}), ','));
    sc = bins - 32;                                    % fftshift 0-based -> 有符号子载波

    % assign w_p_neg = (i_sub == P_IDX_W'(P_PILOT_POS[2]));
    n = regexp(txt, 'w_p_neg\s*=\s*\(\s*i_sub\s*==\s*[^)]*P_PILOT_POS\s*\[\s*(\d+)\s*\]', 'tokens', 'once');
    if isempty(n)
        error('chain_pilot_contract:parse', '从 cpe_tracker.sv 读不出 w_p_neg 落在哪一位');
    end
    val = ones(1, numel(sc));
    val(str2double(n{1}) + 1) = -1;                    % SV 下标 0-based

    % 逐符号极性机制: 认"有一个每符号翻转的极性寄存器, 且它参与 S 的锁存"。
    % 只查名字不算数 —— 必须同时看到它在符号尾翻转、且在锁存 S 时被用到,
    % 否则一个悬空的 r_pol_neg 也会被判成"有极性"。
    has_reg  = ~isempty(regexp(txt, 'r_pol_neg\s*<=\s*~r_pol_neg', 'once'));
    has_use  = ~isempty(regexp(txt, 'r_pol_neg\s*\?\s*-r_s_re', 'once'));
    pol = has_reg && has_use;

    src = 'cbb/channel_est_top/rtl/cpe_tracker.sv';
end

% =====================================================================
function data = mod_mapper_bits(cfg, nsym)
%MOD_MAPPER_BITS  造一帧数据符号 (内容不影响导频判据, 但不能全 0 —— 全 0 会让
%   "导频有没有被正确放置"与"数据是不是空的"混在一起看不出来)
    data = zeros(cfg.N_data, nsym);
    for s = 1:nsym
        for d = 1:cfg.N_data
            data(d, s) = mod_mapper(double(rand(2,1) > 0.5), 'QPSK');
        end
    end
end
