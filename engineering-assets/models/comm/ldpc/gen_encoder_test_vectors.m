%% 生成 LDPC 编码器 bit-true 测试向量
% 为 incubator/intake/ldpc_codec/tb/tb_ldpc_encoder_top 导出:
%   vectors/tb_enc_info_<t>.hex  — K=324 信息位, 每行 1 bit
%   vectors/tb_enc_code_<t>.hex  — N=648 码字, 每行 1 bit (系统码: 前 K = info)
%
% 与 gen_rtl_test_vectors.m 相同治理约定:
%   - 固定 rng seed, 可复现
%   - 权威路径 = models/comm/ldpc/vectors/
%   - 导出前 syndrome 自检 H*c = 0 (GF2), 失败则拒绝写出
%
% 用法 (MATLAB batch):
%   cd models/comm/ldpc
%   gen_encoder_test_vectors

addpath(pwd); addpath(fullfile(pwd, 'src')); config;
H = generate_h_matrix(cfg);

fprintf('=== Encoder RTL Test Vector Generation ===\n');

rng(20260731, 'twister');

vec_dir = fullfile(fileparts(mfilename('fullpath')), 'vectors');
if ~exist(vec_dir, 'dir'), mkdir(vec_dir); end
fprintf('  输出目录: %s\n', vec_dir);

% 第 1 组固定全零; 其余随机非全零。共 5 组与 TB 默认 N_TESTS 对齐。
num_tests = 5;

for t = 1:num_tests
    if t == 1
        info = zeros(cfg.K, 1);
    else
        info = randi([0 1], cfg.K, 1);
        % 保证至少有 1 个 1, 避免与全零重复
        if all(info == 0)
            info(1) = 1;
        end
    end

    code = ldpc_encode_80211n(info, H, cfg);
    code = double(code(:));
    info = double(info(:));

    if ~isequal(code(1:cfg.K), info)
        error('gen_encoder_test_vectors:systematicFail', ...
              'Test %d: 系统码性质失败 (code(1:K) ~= info)', t);
    end

    syndrome = mod(double(H) * code, 2);
    if nnz(syndrome) ~= 0
        error('gen_encoder_test_vectors:syndromeFail', ...
              'Test %d: H*c 非零 (nnz=%d) —— 拒绝导出', t, nnz(syndrome));
    end

    info_path = fullfile(vec_dir, sprintf('tb_enc_info_%d.hex', t));
    code_path = fullfile(vec_dir, sprintf('tb_enc_code_%d.hex', t));
    fid_i = fopen(info_path, 'w');
    fid_c = fopen(code_path, 'w');
    if fid_i < 0 || fid_c < 0
        error('gen_encoder_test_vectors:openFailed', '无法写入 %s', vec_dir);
    end
    for i = 1:cfg.K
        fprintf(fid_i, '%1d\n', info(i));
    end
    for i = 1:cfg.N
        fprintf(fid_c, '%1d\n', code(i));
    end
    fclose(fid_i);
    fclose(fid_c);

    fprintf('  Test %d: info_w=%d code_w=%d syndrome_ok -> %s / %s\n', ...
        t, sum(info), sum(code), sprintf('tb_enc_info_%d.hex', t), sprintf('tb_enc_code_%d.hex', t));
end

fprintf('=== Encoder vectors: %d groups written ===\n', num_tests);
