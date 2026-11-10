function [llr, info] = mod_demapper_llr(x, w, mod_type, sigma2)
%MOD_DEMAPPER_LLR  软判决解调 (max-log LLR) —— 解调器 RTL 的正确性锚
%
%   [llr, info] = mod_demapper_llr(x, w, mod_type, sigma2)
%
%   与 mod_demapper.m 的关系 (owner 裁定⑥, 2026-08-05): 那一支是**硬判决**, 保持
%   原样不动 (rx_chain / test_ber 依赖它); 本函数另起, 专供需要软信息的下游 ——
%   cbb/ldpc_codec 吃的是 LLR Q(10,4) + 归一化 Min-Sum, 硬比特喂不进去。
%
%   ## 符号约定 —— 本文件最要紧的一段
%
%   两个 golden 族的比特-符号映射**方向相反**, 且此前无人强迫它们对上:
%     models/comm/ofdm  mod_mapper.m:            s = 2b - 1   (bit 1 -> +1)
%     models/comm/ldpc  gen_rtl_test_vectors.m:  s = 1 - 2c   (bit 0 -> +1)
%                                                llr = 2y/sigma2  => 正 LLR = bit 0
%   下游是 ldpc_codec, 故本函数按**后者**输出: **正 LLR 表示该比特更可能是 0**。
%   相对于"直接看 OFDM 符号正负"的直觉, 这等于要**翻一个号**。BPSK 可闭式验证:
%     LLR = log P(b=0)/P(b=1) = [-(y+1)^2 + (y-1)^2] / (2 sigma2) = -2y/sigma2
%   即 llr_calc.m 那条式子的相反数。搞错这个号, 译码器会整体失效, 而现象看着像
%   "译码器不工作"而不是"符号反了" —— 所以在这里写死并由测试锁住。
%
%   ## 算法: 穷举 max-log, 星座与比特标号**取自治理侧 mod_mapper**
%
%     LLR(b) = [ min_{s: b=1} |y-s|^2 - min_{s: b=0} |y-s|^2 ] / (2 sigma2) * w
%
%   刻意不重新推导 Gray 表, 而是把全部 M 个比特组合过一遍 mod_mapper 得到星座点与
%   其标号 —— 锚必须绑在治理资产上。qam_gray_map 的内部映射一旦变动, 本函数自动跟随,
%   不会出现"两处各写一份 Gray 表, 改了一处"的漂移。代价是 O(M) 穷举, golden 不在乎。
%
%   ## 逐子载波加权 w
%
%   ZF 之后第 k 个载波的等效噪声方差是 sigma2/|H_k|^2, 故 LLR 应乘 |H_k|^2。这就是
%   参数 w 的来源 (owner 裁定⑤: eq_zf 升 1.1.0 补出该可靠度侧带)。
%   **归一化 Min-Sum 对 LLR 的全局标度不敏感**, 所以 sigma2 的绝对值不要紧 (默认 1);
%   但**逐载波的相对权重要紧** —— ZF 把幅度归一化掉了, 不加权则深衰落载波会以与强载波
%   相同的置信度进译码器, 正好是反的。
%   w=0 的载波 (|H|^2=0, 即 eq_zf 的 erasure) 自然得到 LLR=0, 即最大不确定 —— 这正是
%   软译码器眼中"擦除"的正确表示, 裁定④ 的 erasure 语义到此闭环。
%
%   输入:
%     x        - [N x K] 或 [N x 1] 均衡后符号 (复数, 与 mod_mapper 同一功率归一化)
%     w        - 与 x 同形的逐点权重 (|H|^2); 标量则广播; [] 视为全 1 (等权重)
%     mod_type - 'BPSK' | 'QPSK' | '16QAM' | '64QAM'
%     sigma2   - 噪声方差, 可省 (默认 1)。Min-Sum 标度不敏感, 它只影响整体幅度
%   输出:
%     llr      - [N*bps x K] 每符号 bps 个 LLR, 比特次序与 mod_mapper 一致 (b0 在前)
%     info     - .bps 每符号比特数  .constellation 星座点  .labels 比特标号
%                .n_erasure w=0 的点数  .max_abs 最大 |LLR|
%                .q104_sat 若按 Q(10,4) 量化 (x16, 饱和到 [-512,511]) 会饱和的比例

    if nargin < 4 || isempty(sigma2), sigma2 = 1; end
    if nargin < 2 || isempty(w),      w = 1;      end

    validateattributes(x, {'numeric'}, {'nonempty'}, mfilename, 'x');
    if ~isscalar(w) && ~isequal(size(w), size(x))
        error('mod_demapper_llr:dim', 'w 须与 x 同形或为标量, 实得 %s vs %s', ...
              mat2str(size(w)), mat2str(size(x)));
    end
    if any(w(:) < 0)
        error('mod_demapper_llr:weight', 'w 是 |H|^2, 不得为负');
    end

    %% --- 星座与比特标号: 全部取自治理侧 mod_mapper, 不另写 Gray 表 ---
    bps = bits_per_symbol(mod_type);
    M   = 2^bps;
    labels = zeros(M, bps);
    consts = zeros(M, 1);
    for m = 0:M-1
        b = bitget(m, bps:-1:1).';              % b(1) 是 mod_mapper 的第一个比特
        labels(m+1, :) = b.';
        consts(m+1)    = mod_mapper(double(b(:)), mod_type);
    end

    %% --- max-log ---
    xs = x(:);
    if isscalar(w), ws = repmat(double(w), numel(xs), 1); else, ws = double(w(:)); end
    n  = numel(xs);

    d2 = abs(xs - consts.').^2;                 % [n x M] 到各星座点的平方距离
    llr_col = zeros(n, bps);
    for k = 1:bps
        is1 = labels(:, k) == 1;
        min1 = min(d2(:, is1),  [], 2);
        min0 = min(d2(:, ~is1), [], 2);
        llr_col(:, k) = (min1 - min0) ./ (2 * sigma2) .* ws;   % 正 = 更可能是 0
    end

    % 展平成"每符号 bps 个, b0 在前", 与 mod_mapper 消费比特的次序一致
    K   = size(x, 2);
    llr = reshape(reshape(llr_col.', bps * size(x, 1), K), bps * size(x, 1), K);

    info = struct( ...
        'bps',           bps, ...
        'constellation', consts, ...
        'labels',        labels, ...
        'n_erasure',     sum(ws == 0), ...
        'max_abs',       max(abs(llr(:))), ...
        'q104_sat',      mean(abs(round(llr(:) * 16)) > 511));
end

% =====================================================================
function bps = bits_per_symbol(mod_type)
    switch upper(mod_type)
        case 'BPSK',  bps = 1;
        case 'QPSK',  bps = 2;
        case '16QAM', bps = 4;
        case '64QAM', bps = 6;
        otherwise, error('mod_demapper_llr:mod', '不支持的调制方式: %s', mod_type);
    end
end
