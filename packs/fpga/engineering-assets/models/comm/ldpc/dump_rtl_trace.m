%% 导出定点 golden 的逐边轨迹, 供 RTL cosim 定位第一处发散点
%
%  背景: 译码器有 20 次迭代 x 324 行 x ~7 条边 = 4.5 万个中间量, 只比最终
%  324 位硬判决时, 任何一处错都表现为"输出不对", 无法定位。本脚本把 golden
%  的 (iter,row,j,col,L_q,L_r,LLR_new) 逐条导出, TB 按同样顺序比对, 第一条
%  不符即指出发散点。
%
%  输出 (到 ../../../var/gates/pg/ldpc_codec/trace/):
%    golden_trace_1.hex   — 每行 "iter row j col lq lr llr" (十进制, 空格分隔)
%    golden_iterllr_1.hex — 每次迭代结束后的 648 个 LLR_total (十进制, 每行一个)
%
%  轨迹不是验收证据, 是调试辅助; 验收仍以最终 324 位硬判决为准 (G-B-03)。

addpath(pwd); addpath(fullfile(pwd,'src')); config;
H = generate_h_matrix(cfg);

% internal_bits=10 见 gen_rtl_test_vectors.m 的说明 (规格 stage3 §6: 饱和到 [-512,511])
RTL_MAX_ITER = 20;
q_config = struct('total_bits', 10, 'frac_bits', 4, 'internal_bits', 10);

vec_dir = fullfile(fileparts(mfilename('fullpath')), 'vectors');
out_dir = fullfile(fileparts(mfilename('fullpath')), '..', '..', '..', ...
                   'var', 'gates', 'pg', 'ldpc_codec', 'trace');
if ~exist(out_dir, 'dir'), mkdir(out_dir); end

% ---------------------------------------------------------------------------
% 0. 回归: trace 输出必须不改变译码结果
%    trace 是纯观测代码, 但"纯观测"要有证据, 不能靠声称。
% ---------------------------------------------------------------------------
rng(20260726, 'twister');
info_chk = randi([0 1], cfg.K, 1);
code_chk = ldpc_encode_80211n(info_chk, H, cfg);
tx_chk   = 1 - 2*double(code_chk);
sigma2   = 1/(2*cfg.R*10^(3.0/10));
rx_chk   = tx_chk + sqrt(sigma2)*randn(cfg.N,1);
llr_chk  = 2*rx_chk/sigma2;

[d2, n2]        = ldpc_decoder_ms_fixed(llr_chk, H, RTL_MAX_ITER, 0.75, q_config);
[d3, n3, ~]     = ldpc_decoder_ms_fixed(llr_chk, H, RTL_MAX_ITER, 0.75, q_config);
if ~isequal(d2, d3) || n2 ~= n3
    error('dump_rtl_trace:traceAltersResult', ...
          'trace 采集改变了译码结果 —— 仪表化不是纯观测, 拒绝导出');
end
fprintf('[trace] 回归通过: 开/关 trace 的 dec_bits 与 num_iter 完全一致 (iter=%d)\n', n2);

% ---------------------------------------------------------------------------
% 0b. 全量自洽性检查: 每组向量的 expected 必须能由 golden 从同组 LLR 复算出来。
%     若某组对不上, 说明是向量本身的问题, 不是 RTL —— 必须先分清, 否则会
%     照着一份错误的期望值去改实现。
% ---------------------------------------------------------------------------
for t = 1:10
    p = fullfile(vec_dir, sprintf('tb_llr_input_%d.hex', t));
    fid = fopen(p,'r'); raw = textscan(fid,'%s'); fclose(fid);
    hx = raw{1};
    lq = zeros(cfg.N,1);
    for i = 1:cfg.N
        vv = hex2dec(hx{i});
        if vv >= 512, vv = vv - 1024; end
        lq(i) = vv;
    end
    [dd, nn] = ldpc_decoder_ms_fixed(lq/16, H, RTL_MAX_ITER, 0.75, q_config);
    pe = fullfile(vec_dir, sprintf('tb_expected_output_%d.hex', t));
    fid = fopen(pe,'r'); raw = textscan(fid,'%d'); fclose(fid);
    ee = double(raw{1});
    ne = sum(dd(:) ~= ee(:));
    if ne == 0
        fprintf('[trace] 向量 %2d 自洽 (golden %d 次迭代复算, 324 位全同)\n', t, nn);
    else
        fprintf('[trace] *** 向量 %2d 不自洽: golden 复算与 expected 差 %d 位 ***\n', t, ne);
    end
end

% ---------------------------------------------------------------------------
% 1. 用指定向量 (默认第 1 组) 导出轨迹
%    LLR 直接从已导出的 hex 反读, 保证与 RTL 吃到的完全同源。
% ---------------------------------------------------------------------------
if ~exist('TRACE_VEC', 'var'), TRACE_VEC = 1; end
llr_path = fullfile(vec_dir, sprintf('tb_llr_input_%d.hex', TRACE_VEC));
fid = fopen(llr_path, 'r');
if fid < 0, error('dump_rtl_trace:noVector', '找不到向量 %s', llr_path); end
raw = textscan(fid, '%s'); fclose(fid);
hexcells = raw{1};
if numel(hexcells) ~= cfg.N
    error('dump_rtl_trace:badVector', '%s 有 %d 行, 期望 %d', llr_path, numel(hexcells), cfg.N);
end
llr_q = zeros(cfg.N, 1);
for i = 1:cfg.N
    v = hex2dec(hexcells{i});
    if v >= 512, v = v - 1024; end     % 10-bit 二补码还原
    llr_q(i) = v;
end

% golden 内部会做 round(llr_float*16) 再饱和; 这里反推一个能精确还原 llr_q
% 的浮点输入, 使 golden 吃到的量化值与 RTL 逐位相同。
llr_float_equiv = llr_q / 16;

[dec, nit, tr] = ldpc_decoder_ms_fixed(llr_float_equiv, H, RTL_MAX_ITER, 0.75, q_config);

exp_path = fullfile(vec_dir, sprintf('tb_expected_output_%d.hex', TRACE_VEC));
fid = fopen(exp_path, 'r'); raw = textscan(fid, '%d'); fclose(fid);
expected = double(raw{1});
if ~isequal(dec(:), expected(:))
    error('dump_rtl_trace:mismatch', ...
          'golden 对第 %d 组向量的译码结果与 expected 不符 (%d bit 错)', ...
          TRACE_VEC, sum(dec(:) ~= expected(:)));
end
fprintf('[trace] golden 复算第 %d 组向量: %d 次迭代收敛, 324 位与期望完全一致\n', TRACE_VEC, nit);

% ---------------------------------------------------------------------------
% 2. 写轨迹
%    列序 = RTL 数据通路顺序; col/row 转成 0-based 以匹配 Verilog 索引。
% ---------------------------------------------------------------------------
fid = fopen(fullfile(out_dir, sprintf('golden_trace_%d.hex', TRACE_VEC)), 'w');
fprintf(fid, '# iter row j col lq lr llr   (row/col/j 均 0-based, 值为十进制有符号)\n');
fprintf(fid, '# n_edges=%d num_iter=%d\n', tr.n_edges, nit);
for k = 1:tr.n_edges
    fprintf(fid, '%d %d %d %d %d %d %d\n', ...
        tr.iter(k)-1, tr.row(k)-1, tr.j(k)-1, tr.col(k)-1, ...
        tr.lq(k), tr.lr(k), tr.llr(k));
end
fclose(fid);

fid = fopen(fullfile(out_dir, sprintf('golden_iterllr_%d.hex', TRACE_VEC)), 'w');
fprintf(fid, '# 每次迭代结束后的 LLR_total, 共 %d 次 x %d 个\n', size(tr.iter_llr,2), cfg.N);
fprintf(fid, '%d\n', tr.iter_llr(:));
fclose(fid);

fprintf('[trace] 已导出 %d 条边轨迹 + %d 次迭代快照 -> %s\n', ...
    tr.n_edges, size(tr.iter_llr,2), out_dir);

% ---------------------------------------------------------------------------
% 3. 顺带把 RTL 需要的每行连接数与首行结构打印出来, 便于核对地址表
% ---------------------------------------------------------------------------
row_wt = full(sum(H(1:min(4,size(H,1)), :) ~= 0, 2));
fprintf('[trace] 前 4 行连接数: %s\n', mat2str(row_wt'));
fprintf('[trace] 第 0 行列索引(0-based): %s\n', mat2str(find(H(1,:))-1));
