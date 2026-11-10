function [dec_bits, num_iter, trace] = ldpc_decoder_ms_fixed(llr_float, H, max_iter, scale_factor, q_config)
% <LDPC> 定点 Min-Sum 译码器 (硬件参考模型)
%
% 模拟真实 FPGA 定点实现:
%   - 输入 LLR: 量化到 Q(total_bits, frac_bits)
%   - 内部计算: 使用 Q(internal_bits, frac_bits) 高精度
%   - CN 消息 α 缩放: 定点乘法 + 截断
%   - VN 累加: 饱和到 internal 范围
%   - 硬判决: 符号位
%
% 输入:
%   q_config.total_bits    - I/O 位宽 (默认 8)
%   q_config.frac_bits     - 小数位宽 (默认 4)
%   q_config.internal_bits - 内部计算位宽 (默认 total_bits + 2)

    if nargin < 4, scale_factor = 0.75; end
    if nargin < 5
        q_config.total_bits = 8;
        q_config.frac_bits = 4;
    end
    if ~isfield(q_config, 'internal_bits')
        q_config.internal_bits = q_config.total_bits + 2;
    end

    [M, N] = size(H);
    K = N - M;

    F   = q_config.frac_bits;
    INT = q_config.internal_bits;

    SCALE = 2^F;
    MAX_INT  =  2^(INT - 1) - 1;    % 有符号最大整数 (如 10-bit → 511)
    MIN_INT  = -2^(INT - 1);         % 有符号最小整数 (如 10-bit → -512)
    ALPHA_FIXED = round(scale_factor * SCALE);

    % 预处理: 获取每行的列索引
    row_cols = cell(M, 1);
    for row = 1:M
        row_cols{row} = find(H(row, :));
    end

    %% 量化信道 LLR 输入 (I/O 精度)
    llr_q = round(llr_float(:) * SCALE);
    io_max = 2^(q_config.total_bits - 1) - 1;
    io_min = -2^(q_config.total_bits - 1);
    llr_q = max(min(llr_q, io_max), io_min);

    %% 初始化内部状态 (内部高精度)
    LLR_total = double(llr_q);        % [N×1]
    L_r_old   = zeros(M, N);          % 旧 CN→VN 消息 [M×N]

    %% 可选逐边轨迹 (nargout>2 时才采集)
    % 纯观测: 只读取上面已算出的量, 不参与任何运算, 因此打开与否
    % dec_bits/num_iter 逐位不变。用途是让 RTL cosim 能按 (iter,row,edge)
    % 定位第一处发散点, 而不是只拿到一个最终的 324 位对错。
    want_trace = (nargout > 2);
    trace = struct();
    if want_trace
        nnz_total = nnz(H);
        cap = nnz_total * max_iter;
        tr_iter = zeros(cap, 1); tr_row = zeros(cap, 1); tr_j = zeros(cap, 1);
        tr_col  = zeros(cap, 1); tr_lq  = zeros(cap, 1); tr_lr = zeros(cap, 1);
        tr_llr  = zeros(cap, 1);
        tr_n = 0;
        trace.llr_init = LLR_total(:);
        trace.iter_llr = [];
    end

    %% 主迭代循环
    for iter = 1:max_iter
        for row = 1:M
            cols = row_cols{row};
            if isempty(cols), continue; end

            % VN→CN: L_q = LLR_total - L_r_old
            L_q = LLR_total(cols) - L_r_old(row, cols).';

            % Min-Sum CN 更新
            abs_q  = abs(L_q);
            signs  = sign(L_q);
            signs(signs == 0) = 1;  % 关键修复: sign(0) → +1 (硬件做法)

            [min1, min1_idx] = min(abs_q);
            if length(cols) > 1
                abs_q2 = abs_q;
                abs_q2(min1_idx) = inf;
                min2 = min(abs_q2);
            else
                min2 = min1;
            end

            prod_sign = prod(signs);

            for j = 1:length(cols)
                col = cols(j);

                % 选 min1 或 min2
                mv = min2;
                if j ~= min1_idx
                    mv = min1;
                end

                % α 缩放: floor(mv * α_fixed / SCALE) — 硬件截断
                L_r = floor((mv * ALPHA_FIXED) / SCALE);
                L_r = L_r * prod_sign * signs(j);

                % 存储 CN 消息
                L_r_old(row, col) = L_r;

                % VN 更新 (累加 + 饱和到内部范围)
                new_val = L_q(j) + L_r;
                new_val = max(min(new_val, MAX_INT), MIN_INT);
                LLR_total(col) = new_val;

                if want_trace
                    tr_n = tr_n + 1;
                    tr_iter(tr_n) = iter;   tr_row(tr_n) = row;  tr_j(tr_n) = j;
                    tr_col(tr_n)  = col;    tr_lq(tr_n)  = L_q(j);
                    tr_lr(tr_n)   = L_r;    tr_llr(tr_n) = new_val;
                end
            end
        end

        if want_trace
            trace.iter_llr(:, end+1) = LLR_total(:);
        end

        %% 硬判决 + 早停
        hard = double(LLR_total < 0);
        if mod(H * hard(:), 2) == 0
            dec_bits = hard(1:K);
            num_iter = iter;
            if want_trace
                trace = pack_trace(trace, tr_n, tr_iter, tr_row, tr_j, tr_col, tr_lq, tr_lr, tr_llr);
            end
            return;
        end
    end

    hard = double(LLR_total < 0);
    dec_bits = hard(1:K);
    num_iter = max_iter;
    if want_trace
        trace = pack_trace(trace, tr_n, tr_iter, tr_row, tr_j, tr_col, tr_lq, tr_lr, tr_llr);
    end
end

function trace = pack_trace(trace, n, it, rw, jj, cl, lq, lr, llr)
% 把预分配数组裁到实际长度并装进 trace 结构体。
    trace.n_edges = n;
    trace.iter = it(1:n);  trace.row = rw(1:n);  trace.j   = jj(1:n);
    trace.col  = cl(1:n);  trace.lq  = lq(1:n);  trace.lr  = lr(1:n);
    trace.llr  = llr(1:n);
end
