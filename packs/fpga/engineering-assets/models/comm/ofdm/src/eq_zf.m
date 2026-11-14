function [x_data, info] = eq_zf(Y, H, cfg)
%EQ_ZF  迫零 (ZF) 频域均衡 + 数据子载波提取 —— 均衡器的正确性锚
%
%   [x_data, info] = eq_zf(Y, H, cfg)
%
%   算法 (owner 裁定 2026-08-04): X = Y / H, 但**按共轭乘 + 倒数的形式**写,
%   与 RTL 的实现路径一致:
%
%       X_k = Y_k * conj(H_k) * (1 / |H_k|^2)
%
%   为什么不直接写 Y./H: 本函数是 RTL 的正确性锚, 而 RTL 走的是"共轭乘 + 实数
%   倒数"这条路 (复数除法在硬件上要么代价高、要么精度难控)。锚要贴合被判定对象
%   的**运算路径**, 否则定点镜像与 RTL 对齐时会把算法差异误当成量化误差。
%   浮点下两种写法数学等价, 这里的选择只影响可读性与后续定点镜像的对应关系。
%
%   为什么是 ZF 而非 MMSE (owner 裁定 2026-08-04): channel_est_top 只产出 H,
%   不产出噪声方差; MMSE 需要 sigma^2, 那要么新起一个噪声估计器、要么做成静态
%   侧带配入 —— 两者都是范围扩张。ZF 是 802.11a 基线的标准做法, 且与已认证的
%   LTS-LS 估计配套。代价明写在 info.zf_noise_gain 里 (见下)。
%
%   子载波提取 (owner 裁定 2026-08-04): 64 -> 48 在**本函数内**完成, 输出直接
%   就是数据子载波。理由: 导频/DC/保护带的 H 本来就不该被使用, 且下游 mod_demapper
%   期望的正是 cfg.N_data 个载波 (与 rx_chain 的 cfg.data_idx 同一约定)。
%
%   输入:
%     Y   - [N x N_sym] 复数, FFT 输出 (自然序, bin 0..N-1)
%     H   - [N x N_sym] 复数, 信道估计 (同序)
%     cfg - 配置结构体; 用 cfg.N 与 cfg.data_idx
%   输出:
%     x_data - [N_data x N_sym] 均衡后的数据子载波
%     info   - .bins           数据子载波对应的 bin 下标 (0-based)
%              .h_mag2         各数据载波的 |H|^2
%              .zf_noise_gain  1/|H|^2 —— ZF 的噪声放大系数, 深衰落时会很大。
%                              这是 ZF 相对 MMSE 的代价, 显式返回以便量化评估。
%              .min_h_mag2     最小 |H|^2, 用于判断是否逼近除零

    N = cfg.N;

    if size(Y, 1) ~= N || size(H, 1) ~= N
        error('eq_zf:dim', 'Y 与 H 须为 [%d x N_sym], 实得 %d / %d 行', ...
              N, size(Y, 1), size(H, 1));
    end
    if size(Y, 2) ~= size(H, 2)
        error('eq_zf:dim', 'Y 与 H 的符号数不一致: %d vs %d', size(Y, 2), size(H, 2));
    end

    % --- 数据子载波的 bin 下标 (与 rx_chain 同一换算: 负下标绕到 N+idx) ---
    n_data = numel(cfg.data_idx);
    bins   = zeros(1, n_data);
    for d = 1:n_data
        idx = cfg.data_idx(d);
        if idx < 0
            bins(d) = N + idx;
        else
            bins(d) = idx;
        end
    end

    % --- 只在数据子载波上做均衡 (导频/DC/保护带不参与) ---
    Yd = Y(bins + 1, :);
    Hd = H(bins + 1, :);

    h_mag2 = real(Hd) .^ 2 + imag(Hd) .^ 2;

    if any(h_mag2(:) == 0)
        error('eq_zf:singular', ...
              'ZF 遇到 |H|^2 = 0 的数据子载波 —— 该载波无法均衡; 需要上游保证 H 非零, 或改用 MMSE');
    end

    % X = Y * conj(H) / |H|^2  —— 与 RTL 的共轭乘 + 倒数路径同形
    x_data = (Yd .* conj(Hd)) ./ h_mag2;

    info = struct( ...
        'bins',          bins, ...
        'h_mag2',        h_mag2, ...
        'zf_noise_gain', 1 ./ h_mag2, ...
        'min_h_mag2',    min(h_mag2(:)));
end
