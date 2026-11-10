%% 测量定点 golden 在全部向量上的中间量动态范围, 用于确定 RTL 位宽
%
%  背景: 现 RTL 把 L_q 声明为 10 bit signed (P_Q_DATA_W), 但 golden 的
%  L_q = LLR_total - L_r_old 并不饱和, 实测会超出 ±512 -> 10 bit 静默回绕。
%  位宽必须由实测范围 + 余量决定, 不能沿用"Q(10,4) 所以处处 10 bit"。
%
%  输出: 打印各中间量的全局 min/max 与所需位宽。

addpath(pwd); addpath(fullfile(pwd,'src')); config;
H = generate_h_matrix(cfg);

RTL_MAX_ITER = 20;
q_config = struct('total_bits', 10, 'frac_bits', 4, 'internal_bits', 10);
vec_dir = fullfile(fileparts(mfilename('fullpath')), 'vectors');

g = struct('lq',[inf -inf], 'lr',[inf -inf], 'llr',[inf -inf], 'absq',[inf -inf]);
n_edges_total = 0;

for t = 1:10
    p = fullfile(vec_dir, sprintf('tb_llr_input_%d.hex', t));
    fid = fopen(p,'r'); raw = textscan(fid,'%s'); fclose(fid);
    hx = raw{1};
    llr_q = zeros(cfg.N,1);
    for i = 1:cfg.N
        v = hex2dec(hx{i});
        if v >= 512, v = v - 1024; end
        llr_q(i) = v;
    end
    [~, nit, tr] = ldpc_decoder_ms_fixed(llr_q/16, H, RTL_MAX_ITER, 0.75, q_config);

    g.lq  = [min(g.lq(1),  min(tr.lq)),  max(g.lq(2),  max(tr.lq))];
    g.lr  = [min(g.lr(1),  min(tr.lr)),  max(g.lr(2),  max(tr.lr))];
    g.llr = [min(g.llr(1), min(tr.llr)), max(g.llr(2), max(tr.llr))];
    g.absq= [min(g.absq(1),min(abs(tr.lq))), max(g.absq(2), max(abs(tr.lq)))];
    n_edges_total = n_edges_total + tr.n_edges;
    fprintf('  vec %2d: %2d 次迭代, %5d 条边, L_q[%5d,%5d] L_r[%5d,%5d]\n', ...
        t, nit, tr.n_edges, min(tr.lq), max(tr.lq), min(tr.lr), max(tr.lr));
end

need_bits = @(lo, hi) ceil(log2(max(abs(lo), hi+1))) + 1;   % signed

fprintf('\n=== 全 10 组向量, 共 %d 条边 ===\n', n_edges_total);
fprintf('L_q       : [%5d, %5d]  -> %d bit signed\n', g.lq(1),  g.lq(2),  need_bits(g.lq(1),  g.lq(2)));
fprintf('|L_q|     : [%5d, %5d]  -> %d bit unsigned\n', g.absq(1), g.absq(2), ceil(log2(g.absq(2)+1)));
fprintf('L_r       : [%5d, %5d]  -> %d bit signed\n', g.lr(1),  g.lr(2),  need_bits(g.lr(1),  g.lr(2)));
fprintf('LLR_total : [%5d, %5d]  -> %d bit signed\n', g.llr(1), g.llr(2), need_bits(g.llr(1), g.llr(2)));
